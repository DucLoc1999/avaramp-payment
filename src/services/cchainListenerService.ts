import db from '../db';
import { getAddress } from 'viem';
import { loadCchainConfig, type CchainConfig } from '../config/cchain';
import {
  getBlockNumber,
  getConfirmations,
  getUsdtTransferLogs,
  getBalance,
  getUsdtBalance,
} from './cchainRpcService';
import {
  listOpenCustodialWallets,
  listRetiredCustodialWallets,
  updateListenerCursor,
  type CustodialWalletRow,
} from './cchainWalletService';
import { OrderState } from '../models/types';
import { logger } from '../config/logger';

export type CchainDepositStatus =
  | 'detected'
  | 'confirmed'
  | 'sweeping'
  | 'swept'
  | 'failed'
  | 'abandoned';

/**
 * Deposit states that mean "this address already has a deposit row on record".
 * `abandoned` is terminal — it marks a deposit that exhausted its sweep retries
 * or was handed to a human. Re-detecting it would restart the sweep cycle
 * forever, which is how a permanently unsweepable deposit kept the listener busy.
 */
const KNOWN_DEPOSIT_STATUSES: CchainDepositStatus[] = [
  'detected',
  'confirmed',
  'sweeping',
  'swept',
  'failed',
  'abandoned',
];

export interface CchainDepositRow {
  id: number;
  order_id: number | null;
  address: string;
  asset: 'avax' | 'usdt';
  amount: string;
  block_hash: string | null;
  block_number: string | null;
  tx_hash: string | null;
  log_index: number | null;
  status: CchainDepositStatus;
  sweep_tx_hash: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Poll the C-Chain for USDT deposits on custodial addresses belonging to OPEN
 * sell orders. Records newly observed `Transfer` logs into `cchain_deposits`.
 *
 * Three properties this function must keep, all of which were violated and
 * caused a permanent listener livelock:
 *
 *  1. **Bounded range.** Each `eth_getLogs` call covers at most
 *     `logScanChunkBlocks`. An unbounded `cursor → head` range that grows after
 *     an outage (Avalanche C-Chain does ~2s blocks) reaches tens of millions of
 *     blocks, which no RPC will ever answer, so every retry times out forever.
 *  2. **Durable progress.** The cursor is persisted after every chunk, so a
 *     failure mid-range neither loses completed work nor replays it, and the
 *     range cannot grow on the next poll.
 *  3. **Per-address isolation.** A throw on one address must not abort the
 *     scan, or the native-balance scan, reconciliation, or the sweep stage —
 *     a single bad address used to stall every one of them indefinitely.
 *
 * Closed orders are NOT polled here; see `reconcileSellDepositBalances`.
 */
export async function scanCchainDeposits(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ detected: number; confirmed: number }> {
  const cfg = loadCchainConfig(env);
  const wallets = await listOpenCustodialWallets();
  if (wallets.length === 0) return { detected: 0, confirmed: 0 };

  const currentBlock = await getBlockNumber(env);
  const monitored = new Set(wallets.map((w) => getAddress(w.address)));

  let detected = 0;
  for (const wallet of wallets) {
    try {
      detected += await scanWalletUsdtLogs(wallet, monitored, currentBlock, cfg, env);
    } catch (error) {
      // Isolated on purpose: one unwalkable address must not stop the others,
      // nor the stages that run after this function.
      logger.error(
        {
          address: wallet.address,
          orderId: wallet.order_id,
          cursor: wallet.last_scanned_block,
          head: currentBlock.toString(),
          error: (error as Error).message,
        },
        '[CchainListener] USDT log scan failed for custodial address'
      );
    }
  }

  return { detected, confirmed: 0 };
}

/**
 * Scan one custodial address for USDT transfers, in bounded chunks, persisting
 * the cursor after each chunk.
 */
async function scanWalletUsdtLogs(
  wallet: CustodialWalletRow,
  monitored: Set<string>,
  toBlock: bigint,
  cfg: CchainConfig,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const address = getAddress(wallet.address);
  const lookback = BigInt(Math.max(1, cfg.depositConfirmations)) * 4n;
  const nextBlock = toBlock + 1n;
  const stored = wallet.last_scanned_block ? BigInt(wallet.last_scanned_block) : null;
  let fromBlock =
    stored !== null ? stored + 1n : nextBlock - lookback < 0n ? 0n : nextBlock - lookback;

  // Clamp a hopelessly stale cursor. The skipped range is not silently lost:
  // `reconcileSellDepositBalances` reads live balances and catches anything the
  // log scan missed, which is O(1) per address and cannot time out.
  const span = toBlock - fromBlock + 1n;
  if (span > cfg.logScanMaxSpanBlocks) {
    const clampedFrom = toBlock - cfg.logScanMaxSpanBlocks + 1n;
    logger.warn(
      {
        address,
        staleFrom: fromBlock.toString(),
        clampedFrom: clampedFrom.toString(),
        skippedBlocks: (clampedFrom - fromBlock).toString(),
      },
      '[CchainListener] Clamping stale USDT log cursor; gap covered by balance reconciliation'
    );
    fromBlock = clampedFrom;
  }

  let detected = 0;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = min(cursor + cfg.logScanChunkBlocks - 1n, toBlock);
    const logs = await getUsdtTransferLogs(
      (to) => monitored.has(to as `0x${string}`),
      cursor,
      chunkEnd,
      env
    );

    for (const log of logs) {
      await db('cchain_deposits')
        .insert({
          address: getAddress(log.to),
          asset: 'usdt',
          amount: log.value.toString(),
          block_hash: log.blockHash,
          block_number: log.blockNumber.toString(),
          tx_hash: log.txHash,
          log_index: log.logIndex,
          status: 'detected',
        })
        .onConflict(['address', 'asset', 'tx_hash', 'log_index'])
        .ignore();
    }
    detected += logs.length;

    // Persist per chunk: a throw on the next chunk resumes here, not from the
    // original fromBlock, so the range can never grow across polls.
    await updateListenerCursor(address, { last_scanned_block: chunkEnd.toString() });
    cursor = chunkEnd + 1n;
  }

  return detected;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Detect native AVAX balance increases on custodial addresses of OPEN orders vs
 * the persisted baseline. New wallets are provisioned with a `0` baseline so any
 * incoming AVAX is detected even if the listener restarts between funding and
 * the next poll.
 */
export async function scanCchainNativeBalances(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ detected: number }> {
  const wallets = await listOpenCustodialWallets();
  let detected = 0;
  for (const wallet of wallets) {
    try {
      const address = getAddress(wallet.address);
      const balance = await getBalance(address, env);
      const prev = wallet.native_baseline != null ? BigInt(wallet.native_baseline) : 0n;
      if (balance > prev) {
        const amount = balance - prev;
        await db('cchain_deposits')
          .insert({
            address,
            asset: 'avax',
            amount: amount.toString(),
            block_hash: null,
            block_number: null,
            tx_hash: null,
            log_index: null,
            status: 'confirmed',
          })
          .onConflict(['address', 'asset', 'tx_hash', 'log_index'])
          .ignore();
        await updateListenerCursor(address, { native_baseline: balance.toString() });
        detected += 1;
      } else if (balance < prev) {
        // Draining below baseline (sweeps lowering the balance) — adjust baseline.
        await updateListenerCursor(address, { native_baseline: balance.toString() });
      }
    } catch (error) {
      logger.error(
        { address: wallet.address, orderId: wallet.order_id, error: (error as Error).message },
        '[CchainListener] Native AVAX balance scan failed for custodial address'
      );
    }
  }
  return { detected };
}

/**
 * Balance-based safety net for sell orders, covering both a missed log scan and
 * a deposit that arrives after the order closed.
 *
 * Two populations:
 *  - **Open orders** (`CREATED` / `PROCESSING`): guarantees a missed or clamped
 *    log-scan range can never strand user funds.
 *  - **Recently closed orders** (within `closedWalletWatchMs`): a user who sends
 *    USDT minutes after the order expired must still have the funds noticed, so
 *    they can be swept or refunded. These get no log scan — only this cheap
 *    balance read — which is what stops a cancelled order from pinning the
 *    listener open forever.
 *
 * Addresses whose deposit is already `abandoned` are skipped entirely: that
 * status means a human owns the case, and re-detecting it would restart the
 * sweep cycle every poll.
 */
export async function reconcileSellDepositBalances(
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const cfg = loadCchainConfig(env);

  const openOrders = await db('orders')
    .where({ direction: 'sell' })
    .whereIn('order_state', [OrderState.CREATED, OrderState.PROCESSING])
    .whereNotNull('recipient')
    .select('recipient') as Array<{ recipient: string }>;

  const retiredWallets = await listRetiredCustodialWallets(cfg.closedWalletWatchMs);

  const candidates = [
    ...openOrders.map((o) => o.recipient),
    ...retiredWallets.map((w) => w.address),
  ];
  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const seen = new Set<string>();
  for (const recipient of candidates) {
    let address: `0x${string}`;
    try {
      address = getAddress(recipient);
    } catch {
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const existing = await db('cchain_deposits')
        .where({ address })
        .whereIn('status', KNOWN_DEPOSIT_STATUSES)
        .first();
      if (existing) continue;

      const [usdtBalance, nativeBalance] = await Promise.all([
        getUsdtBalance(address, env),
        getBalance(address, env),
      ]);
      if (usdtBalance > 0n) {
        await db('cchain_deposits').insert({
          address,
          asset: 'usdt',
          amount: usdtBalance.toString(),
          status: 'confirmed',
        });
        reconciled += 1;
      }
      if (nativeBalance > 0n) {
        await db('cchain_deposits').insert({
          address,
          asset: 'avax',
          amount: nativeBalance.toString(),
          status: 'confirmed',
        });
        reconciled += 1;
      }
      if (usdtBalance > 0n || nativeBalance > 0n) {
        logger.warn({ address }, '[CchainListener] Reconciled missed deposit(s)');
      }
    } catch (error) {
      logger.error(
        { address, error: (error as Error).message },
        '[CchainListener] Balance reconciliation failed'
      );
    }
  }
  return reconciled;
}

/**
 * Advance `detected` USDT deposits to `confirmed` once their transaction has
 * reached the required confirmation depth.
 */
export async function confirmPendingUsdtDeposits(
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const cfg = loadCchainConfig(env);
  const pending = await db('cchain_deposits')
    .where({ asset: 'usdt', status: 'detected' })
    .whereNotNull('tx_hash');

  let confirmed = 0;
  for (const dep of pending as CchainDepositRow[]) {
    if (!dep.tx_hash) continue;
    const depth = await getConfirmations(dep.tx_hash as `0x${string}`, env);
    if (depth >= BigInt(cfg.depositConfirmations)) {
      await db('cchain_deposits').where({ id: dep.id }).update({ status: 'confirmed' });
      confirmed += 1;
    }
  }
  return confirmed;
}

/**
 * Deposits ready for a sweep attempt, excluding those still inside their
 * retry backoff.
 *
 * `next_sweep_attempt_at` is written by `cchainOrderService` with an exponential
 * backoff (15s → 10min). This query used to ignore it, so a `failed` deposit
 * was re-emitted every poll — every 5s — defeating the backoff entirely.
 */
export async function listSweepableDeposits(
  env: NodeJS.ProcessEnv = process.env
): Promise<CchainDepositRow[]> {
  const now = new Date();
  return db('cchain_deposits')
    .whereIn('status', ['confirmed', 'failed'])
    .andWhere((qb) =>
      qb.whereNull('next_sweep_attempt_at').orWhere('next_sweep_attempt_at', '<=', now)
    )
    .orderBy('created_at', 'asc');
}