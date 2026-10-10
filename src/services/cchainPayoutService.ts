import { getAddress, isAddress, type Address } from 'viem';
import db from '../db';
import { OrderState, ProcessingState } from '../models/types';
import { fireCallback } from './callbackService';
import { loadCchainConfig } from '../config/cchain';
import {
  getPublicClient,
  getWalletClientForAccount,
  getNativeUsdtContract,
  getBalance,
  getUsdtBalance,
  USDT_ABI,
} from './cchainRpcService';
import { buildTxOverrides, NATIVE_TRANSFER_GAS } from './cchainSweepService';
import { getPayoutAccount, getPayoutAddress } from './cchainPayoutAccount';
import { withNonceLock } from '../utils/nonceLock';
import { allocateNonces, resetNonces } from './nonceManager';
import {
  decimalsForAsset,
  fetchUsdtDecimals,
  isUsdtToken,
  toUnits,
  USDT_DECIMALS_FALLBACK,
} from './cchainUnits';

export interface CchainDisburseResult {
  success: boolean;
  hash?: string;
  txID?: string;
  /** True when the tx is submitted but still gathering confirmations. */
  pending?: boolean;
  /** True when the order was already completed and no transfer was sent. */
  skipped?: boolean;
  error?: string;
}

interface PayoutOrderRow {
  id: number;
  order_state: number;
  processing_state: number | null;
  transaction_hash: string | null;
  recipient: string | null;
  asset_code: string | null;
  token_address: string | null;
  usdt_amount: string | number;
  callback: string | null;
}

const PAYOUT_IN_FLIGHT = ProcessingState.BUY_PAYOUT_IN_FLIGHT;
const PAYOUT_COMPLETED = ProcessingState.BUY_PAYOUT_COMPLETED;
const PAYOUT_FAILED = ProcessingState.BUY_PAYOUT_FAILED;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function completeOrder(order: PayoutOrderRow, hash: string): Promise<CchainDisburseResult> {
  // Guard on the in-flight state so a concurrent inline retry and the periodic
  // reconciler cannot both complete the order and both fire a COMPLETED callback.
  const updated = await db('orders')
    .where({ id: order.id })
    .where('processing_state', PAYOUT_IN_FLIGHT)
    .update({
      order_state: OrderState.COMPLETED,
      processing_state: PAYOUT_COMPLETED,
      transaction_hash: hash,
      payment_status: 'payment_received',
    });

  if (Number(updated ?? 0) === 0) {
    const current = await db('orders').where({ id: order.id }).first<{ order_state: number }>();
    if (current?.order_state === OrderState.COMPLETED) {
      return { success: true, skipped: true, hash, txID: hash };
    }
    return { success: false, error: 'PAYOUT_NOT_COMPLETABLE', hash, txID: hash };
  }

  if (order.callback) {
    fireCallback(
      order.callback,
      order.id,
      OrderState.PROCESSING,
      OrderState.COMPLETED,
      PAYOUT_IN_FLIGHT,
      PAYOUT_COMPLETED,
      hash
    ).catch((err) => console.error('[CchainPayout] fireCallback failed:', err));
  }

  return { success: true, hash, txID: hash };
}

async function failOrder(
  order: PayoutOrderRow,
  error: string,
  hash?: string
): Promise<CchainDisburseResult> {
  const errorMsg = error.slice(0, 500);
  await db('orders')
    .where({ id: order.id })
    .update({
      order_state: OrderState.FAILED,
      processing_state: PAYOUT_FAILED,
      error_message: errorMsg,
      payment_status: 'failed',
      ...(hash ? { transaction_hash: hash } : {}),
    });

  if (order.callback) {
    fireCallback(
      order.callback,
      order.id,
      OrderState.PROCESSING,
      OrderState.FAILED,
      PAYOUT_IN_FLIGHT,
      PAYOUT_FAILED,
      hash
    ).catch((err) => console.error('[CchainPayout] fireCallback failed:', err));
  }

  return { success: false, error: errorMsg, ...(hash ? { hash, txID: hash } : {}) };
}

/** Wait for a submitted payout and complete or fail the order based on confirmations. */
async function confirmPayout(order: PayoutOrderRow, hash: string): Promise<CchainDisburseResult> {
  const cfg = loadCchainConfig();
  const publicClient = getPublicClient();
  const timeout = Number(process.env.CCHAIN_PAYOUT_TIMEOUT_MS || 60_000);

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: hash as `0x${string}`,
      timeout,
    });
    if (receipt.status === 'reverted') {
      return failOrder(order, 'PAYOUT_REVERTED', hash);
    }

    // Derive the depth from the receipt we already hold. Passing `hash` instead
    // makes viem re-fetch the transaction via eth_getTransactionByHash, which a
    // lagging RPC node answers with a null blockNumber (=> 0 confirmations) and
    // would strand the order as "pending" forever.
    const confirmations = await publicClient.getTransactionConfirmations({
      transactionReceipt: receipt,
    });
    if (Number(confirmations) < cfg.payoutConfirmations) {
      return { success: true, pending: true, hash, txID: hash };
    }

    return completeOrder(order, hash);
  } catch (error) {
    return failOrder(order, `PAYOUT_NOT_ACCEPTED: ${errorMessage(error)}`, hash);
  }
}

/**
 * Poll `confirmPayout` for a submitted payout so the SePay webhook response can
 * report COMPLETED instead of leaving every buy to the periodic reconciler.
 *
 * The receipt is usually mined within the first attempt; the retries only matter
 * when the RPC node is a block behind and reports 0 confirmations. Gives up
 * early on any definitive outcome (completed, reverted, failed) and leaves the
 * order `processing_state = PAYOUT_IN_FLIGHT` for the reconciler otherwise.
 */
async function confirmPayoutWithRetry(
  order: PayoutOrderRow,
  hash: string
): Promise<CchainDisburseResult> {
  const attempts = Math.max(1, Number(process.env.CCHAIN_PAYOUT_CONFIRM_ATTEMPTS || 3));
  const delayMs = Math.max(0, Number(process.env.CCHAIN_PAYOUT_CONFIRM_DELAY_MS || 4_000));

  let result = await confirmPayout(order, hash);
  for (let attempt = 1; attempt < attempts && result.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await confirmPayout(order, hash);
    if (result.pending) {
      console.log(
        `[CchainPayout] Payout ${hash} still pending after attempt ${attempt}/${attempts} — leaving for reconciler`
      );
    }
  }

  if (result.pending) {
    console.log(
      `[CchainPayout] Payout ${hash} unresolved after ${attempts} attempts — deferring to reconciler`
    );
  }
  return result;
}

/**
 * Disburse a buy order on the Avalanche C-Chain: native AVAX or ERC-20 USDT to
 * the recipient's 0x address. Idempotent — an order with an existing payout hash
 * is reconciled rather than re-sent, and completed orders are skipped.
 */
export async function disburseCchain(
  orderId: number,
  recipient: string,
  amount: string,
  assetCode: string,
  tokenAddress?: string | null
): Promise<CchainDisburseResult> {
  const order = await db('orders').where({ id: orderId }).first<PayoutOrderRow>();
  if (!order) {
    return { success: false, error: 'ORDER_NOT_FOUND' };
  }

  if (order.order_state === OrderState.COMPLETED) {
    const existing = order.transaction_hash || undefined;
    return { success: true, skipped: true, hash: existing, txID: existing };
  }

  if (order.order_state !== OrderState.PROCESSING) {
    return { success: false, error: 'ORDER_NOT_ELIGIBLE' };
  }

  // Idempotency: reconcile a previously submitted payout instead of sending again.
  if (order.transaction_hash) {
    return confirmPayoutWithRetry(order, order.transaction_hash);
  }

  if (!recipient || !isAddress(recipient)) {
    return failOrder(order, 'RECIPIENT_INVALID_ADDRESS');
  }
  const to = getAddress(recipient) as Address;

  await db('orders').where({ id: order.id }).update({ processing_state: PAYOUT_IN_FLIGHT });

  let account;
  try {
    account = await getPayoutAccount();
  } catch (error) {
    return failOrder(order, `PAYOUT_WALLET_NOT_CONFIGURED: ${errorMessage(error)}`);
  }

  const isUsdt = isUsdtToken(tokenAddress) || (assetCode || '').toUpperCase() === 'USDT';
  let amountUnits: bigint;
  try {
    amountUnits = toUnits(amount, decimalsForAsset(assetCode, tokenAddress));
  } catch (error) {
    return failOrder(order, errorMessage(error));
  }

  const cfg = loadCchainConfig();
  const overrides = await buildTxOverrides();
  const gasCost = NATIVE_TRANSFER_GAS * overrides.maxFeePerGas;

  try {
    if (isUsdt) {
      const [tokenBalance, gasBalance] = await Promise.all([
        getUsdtBalance(account.address),
        getBalance(account.address),
      ]);
      if (tokenBalance < amountUnits) {
        return failOrder(
          order,
          `INSUFFICIENT_BALANCE: available ${tokenBalance}, required ${amountUnits}`
        );
      }
      if (gasBalance < cfg.avaxGasReserveWei + gasCost) {
        return failOrder(
          order,
          `INSUFFICIENT_GAS: available ${gasBalance}, required ${cfg.avaxGasReserveWei + gasCost}`
        );
      }
      } else {
        const balance = await getBalance(account.address);
        // Keep the same gas reserve the USDT branch enforces: an AVAX payout must
        // not drain the balance sweeps rely on to pay their own gas.
        const required = amountUnits + gasCost + cfg.avaxGasReserveWei;
        if (balance < required) {
          return failOrder(order, `INSUFFICIENT_BALANCE: available ${balance}, required ${required}`);
        }
      }
  } catch (error) {
    return failOrder(order, `PAYOUT_PREFLIGHT_FAILED: ${errorMessage(error)}`);
  }

  const wallet = getWalletClientForAccount(account);
  let hash: string;
  try {
    // Serialize with every other send from this address (sell sweeps share the
    // Master/payout address once the wallets are merged) and pin the nonce so a
    // lagging `pending` recount cannot reuse an in-flight nonce.
    hash = await withNonceLock(account.address, async () => {
      const nonce = await allocateNonces(account.address, 1);
      try {
        if (isUsdt) {
          return (await wallet.writeContract({
            address: getNativeUsdtContract(),
            abi: USDT_ABI,
            functionName: 'transfer',
            args: [to, amountUnits],
            nonce,
            ...overrides,
          } as never)) as string;
        }
        return (await wallet.sendTransaction({
          to,
          value: amountUnits,
          nonce,
          ...overrides,
        } as never)) as string;
      } catch (error) {
        resetNonces(account.address);
        throw error;
      }
    });
  } catch (error) {
    return failOrder(order, `PAYOUT_SUBMIT_FAILED: ${errorMessage(error)}`);
  }

  // Record the hash before awaiting confirmation so a crash cannot cause a re-send.
  await db('orders').where({ id: order.id }).update({ transaction_hash: hash });
  return confirmPayoutWithRetry(order, hash);
}

/**
 * Recover buy orders left in the in-flight payout state after a restart:
 * reconcile orders with a recorded hash, re-attempt those without one.
 *
 * `minAgeMs` skips orders that were touched more recently than that, so a
 * periodic caller does not race the in-flight `confirmPayout` of an order that
 * is still legitimately gathering confirmations.
 */
export async function sweepStuckCchainPayouts(minAgeMs = 0): Promise<number> {
  const stuck = await db('orders')
    .where('processing_state', PAYOUT_IN_FLIGHT)
    .where('direction', 'buy')
    .whereIn('order_state', [OrderState.PROCESSING])
    .modify((qb) => {
      if (minAgeMs > 0) {
        qb.where('updated_at', '<=', new Date(Date.now() - minAgeMs));
      }
    })
    .select(
      'id',
      'order_state',
      'processing_state',
      'transaction_hash',
      'recipient',
      'asset_code',
      'token_address',
      'usdt_amount',
      'callback'
    ) as PayoutOrderRow[];

  console.log(`[CchainPayout] Sweep: found ${stuck.length} in-flight payouts`);

  let processed = 0;
  for (const order of stuck) {
    try {
      if (order.transaction_hash) {
        const result = await confirmPayout(order, order.transaction_hash);
        // Still below the confirmation threshold: leave it for the next tick.
        if (result.pending) continue;
      } else if (order.recipient) {
        await disburseCchain(
          order.id,
          order.recipient,
          String(order.usdt_amount),
          order.asset_code || 'AVAX',
          order.token_address
        );
      }
      processed += 1;
    } catch (error) {
      console.error(`[CchainPayout] Failed to recover order ${order.id}:`, errorMessage(error));
    }
  }

  return processed;
}

/**
 * Periodically reconcile buy payouts stuck in the in-flight state. Safety net
 * for the paths that can strand an order after `disburseCchain` returns:
 * a dropped/failed callback, a process restart, or an RPC that under-reports
 * confirmations at submission time.
 */
export function startCchainPayoutReconciler(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.Timeout {
  const intervalMs = Number(env.CCHAIN_PAYOUT_RECONCILE_INTERVAL_MS || 60_000);
  const minAgeMs = Number(env.CCHAIN_PAYOUT_RECONCILE_MIN_AGE_MS || 120_000);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const recovered = await sweepStuckCchainPayouts(minAgeMs);
      if (recovered > 0) {
        console.log(`[CchainPayout] Reconciler recovered ${recovered} stuck payout(s)`);
      }
    } catch (error) {
      console.error('[CchainPayout] Reconciler error:', errorMessage(error));
    } finally {
      running = false;
    }
  };

  console.log(
    `[CchainPayout] Reconciler started (interval: ${intervalMs / 1000}s, min age: ${minAgeMs / 1000}s)`
  );
  void tick();
  return setInterval(() => void tick(), intervalMs);
}

/**
 * Resolve the payout wallet at startup and verify the USDT contract precision.
 * No-op when the C-Chain RPC is not configured.
 */
export async function initCchainPayout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.CCHAIN_RPC_BASE_URL?.trim()) {
    console.log('[CchainPayout] C-Chain RPC not configured, skipping payout init');
    return;
  }
  const address = await getPayoutAddress(env);
  console.log(`[CchainPayout] Payout wallet: ${address}`);

  const decimals = await fetchUsdtDecimals(env);
  if (decimals !== USDT_DECIMALS_FALLBACK) {
    throw new Error(
      `CCHAIN_USDT_DECIMALS_MISMATCH: expected ${USDT_DECIMALS_FALLBACK}, got ${decimals}`
    );
  }
  console.log(`[CchainPayout] USDT contract decimals verified: ${decimals}`);
}
