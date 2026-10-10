import { getAddress } from 'viem';
import db from '../db';
import { OrderState, ProcessingState } from '../models/types';
import { fireCallback } from './callbackService';
import { updateCustodialSwept, getOrderByCustodialAddress } from './cchainPersistence';
import { sweepNativeAvax, sweepUsdt } from './cchainSweepService';
import { CchainDepositEvent } from './cchainEmitServiceTypes';
import { runSellPayout, isSellPayoutEnabled } from './sellPayoutService';
import { logger } from '../config/logger';

/** A sweep left `sweeping` for longer than this is assumed dead and reclaimed. */
const DEFAULT_STALE_SWEEP_MS = 120_000;
/** Attempts before a deposit is parked instead of retried forever. */
const DEFAULT_MAX_SWEEP_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

function staleSweepMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CCHAIN_SWEEP_STALE_MS?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_STALE_SWEEP_MS;
}

function maxSweepAttempts(env: NodeJS.ProcessEnv): number {
  const raw = env.CCHAIN_SWEEP_MAX_ATTEMPTS?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_SWEEP_ATTEMPTS;
}

/** Exponential backoff, capped, so a permanent failure stops consuming gas. */
export function nextSweepRetryDelayMs(attempts: number): number {
  const delay = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/**
 * Record a sweep failure. Never leaves the row in `sweeping`: that state used to
 * be terminal with no re-selection path, so a single throw permanently stranded
 * the user's funds at the custodial address.
 */
async function markSweepFailed(
  depositId: number,
  attempts: number,
  error: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const terminal = attempts >= maxSweepAttempts(env);
  await db('cchain_deposits')
    .where({ id: depositId })
    .update({
      status: terminal ? 'abandoned' : 'failed',
      sweep_attempts: attempts,
      sweeping_started_at: null,
      next_sweep_attempt_at: terminal ? null : new Date(Date.now() + nextSweepRetryDelayMs(attempts)),
      last_sweep_error: error.slice(0, 512),
      updated_at: new Date(),
    });
}

/**
 * Handle a confirmed C-Chain deposit for a custodial address: sweep the funds to
 * the Master Wallet, mark the deposit swept, and if it belongs to an open sell
 * order, complete that order exactly once.
 */
export async function notifyCchainDeposit(
  event: CchainDepositEvent,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ swept: boolean; completed: boolean; error?: string }> {
  const address = getAddress(event.address);

  // Idempotency: never re-sweep a deposit already marked swept, and never touch
  // one that has exhausted its retry budget.
  const deposit = await db('cchain_deposits').where({ id: event.depositId }).first();
  if (!deposit) return { swept: false, completed: false, error: 'DEPOSIT_NOT_FOUND' };
  if (deposit.status === 'swept') return { swept: false, completed: false };
  if (deposit.status === 'abandoned') {
    logger.warn(
      { depositId: event.depositId, address },
      '[CchainOrder] Deposit was abandoned after exhausting sweep retries; ignoring'
    );
    return { swept: false, completed: false, error: 'DEPOSIT_ABANDONED' };
  }

  const attempts = Number(deposit.sweep_attempts ?? 0) + 1;

  // 1) Claim the sweep atomically. The conditional UPDATE is the guard against a
  //    duplicate emit (overlapping poll, retry, reconcile) sweeping twice: a
  //    second claimant transitions 0 rows because the status is already
  //    `sweeping`. `sweeping_started_at` still makes an interrupted claim
  //    reclaimable via `reclaimStaleSweeps`.
  const claimed = await db('cchain_deposits')
    .where({ id: event.depositId })
    .whereIn('status', ['detected', 'confirmed', 'failed'])
    .update({
      status: 'sweeping',
      sweep_attempts: attempts,
      sweeping_started_at: new Date(),
      next_sweep_attempt_at: null,
      updated_at: new Date(),
    });

  if (Number(claimed ?? 0) === 0) {
    return { swept: false, completed: false, error: 'DEPOSIT_IN_FLIGHT' };
  }

  let sweepResult;
  try {
    sweepResult =
      event.asset === 'usdt'
        ? await sweepUsdt(address, BigInt(event.amount), env)
        : await sweepNativeAvax(address, env);
  } catch (error) {
    // A throw from the sweep used to escape here and leave the row in
    // `sweeping` forever. Convert it into an ordinary, observable failure.
    const message = (error as Error).message;
    await markSweepFailed(event.depositId, attempts, message, env);
    logger.error(
      { depositId: event.depositId, address, asset: event.asset, attempts, error: message },
      '[CchainOrder] Sweep threw; deposit marked failed'
    );
    return { swept: false, completed: false, error: message };
  }

  if (!sweepResult.success) {
    await markSweepFailed(event.depositId, attempts, sweepResult.error ?? 'SWEEP_FAILED', env);
    // Previously swallowed entirely, which made a permanently failing sweep
    // indistinguishable from a healthy poll in the logs.
    logger.error(
      {
        depositId: event.depositId,
        address,
        asset: event.asset,
        amount: event.amount,
        attempts,
        error: sweepResult.error,
      },
      '[CchainOrder] Sweep failed'
    );
    return { swept: false, completed: false, error: sweepResult.error };
  }

  // 2) Mark swept.
  let orderId: number | null = deposit.order_id ?? null;
  await db('cchain_deposits')
    .where({ id: event.depositId })
    .update({
      status: 'swept',
      sweep_tx_hash: sweepResult.txHash ?? null,
      sweeping_started_at: null,
      next_sweep_attempt_at: null,
      last_sweep_error: null,
      updated_at: new Date(),
    });

  if (event.asset === 'usdt') {
    await updateCustodialSwept(address, { swept_navax_block: null, swept_usdt_txhash: sweepResult.txHash ?? null });
  } else {
    await updateCustodialSwept(address, { swept_navax_block: sweepResult.txHash ?? null, swept_usdt_txhash: null });
  }

  // 3) Correlate to the owning sell order (recipient = custodial address).
  if (orderId === null) {
    const order = await getOrderByCustodialAddress(address);
    orderId = order?.id ?? null;
  }
  if (orderId === null) {
    // No order — sweep already preserved the funds; log for reconciliation.
    logger.warn(
      { depositId: event.depositId, address, txHash: sweepResult.txHash },
      '[CchainOrder] Swept deposit has no matching sell order'
    );
    return { swept: true, completed: false };
  }
  await db('cchain_deposits').where({ id: event.depositId }).update({ order_id: orderId });

  // 4) Correlate and settle the order (idempotent).
  const order = await db('orders').where({ id: orderId }).first();
  if (!order) return { swept: true, completed: false, error: 'ORDER_NOT_FOUND' };
  if (order.order_state === OrderState.COMPLETED) {
    return { swept: true, completed: false };
  }

  // A late deposit on a cancelled/failed order is swept (funds are safe at the
  // Master wallet) but must never be marked COMPLETED. The owner has to refund or
  // reconcile it manually; completing it here would silently resurrect a closed
  // order and, with the VND pipeline on, pay a seller who was already cancelled.
  if (order.order_state === OrderState.CANCELLED || order.order_state === OrderState.FAILED) {
    logger.warn(
      {
        orderId,
        paymentCode: order.payment_code,
        orderState: order.order_state,
        txHash: sweepResult.txHash,
        asset: event.asset,
      },
      '[CchainOrder] Late deposit on a closed order swept but not completed; refund/reconcile required'
    );
    return { swept: true, completed: false };
  }

  const txHash = sweepResult.txHash ?? null;

  // The VND payout pipeline is opt-in: it moves real money. While it is dark,
  // keep the legacy behaviour where a confirmed sweep completes the order.
  if (!isSellPayoutEnabled(env)) {
    await db('orders')
      .where({ id: orderId })
      .update({
        order_state: OrderState.COMPLETED,
        processing_state: ProcessingState.SELL_PAYOUT_COMPLETED,
        transaction_hash: txHash,
      });

    logger.info(
      { orderId, paymentCode: order.payment_code, txHash },
      '[CchainOrder] Sell order completed from swept deposit (VND payout disabled)'
    );

    if (order.callback) {
      fireCallback(
        order.callback,
        orderId,
        order.order_state,
        OrderState.COMPLETED,
        order.processing_state ?? 0,
        ProcessingState.SELL_PAYOUT_COMPLETED,
        txHash
      ).catch((err) => logger.error({ error: (err as Error).message }, '[CchainOrder] fireCallback failed'));
    }
    return { swept: true, completed: true };
  }

  // Record the sweep hash and hand off to the VND payout pipeline. The order
  // stays PROCESSING until the seller is actually paid; `runSellPayout` is
  // idempotent and the reconciler retries it if this attempt fails.
  await db('orders')
    .where({ id: orderId })
    .update({
      order_state: OrderState.PROCESSING,
      processing_state: ProcessingState.SELL_SWEPT_AWAITING_PAYOUT,
      transaction_hash: txHash,
    });

  const payout = await runSellPayout(orderId, env);
  return { swept: true, completed: payout.success };
}

/**
 * Reclaim deposits stranded in `sweeping` (process death, or a throw that
 * escaped an older build of `notifyCchainDeposit`). Moves them back to `failed`
 * with the backoff applied so the normal queue picks them up.
 */
export async function reclaimStaleSweeps(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cutoff = new Date(Date.now() - staleSweepMs(env));
  const stale = await db('cchain_deposits')
    .where({ status: 'sweeping' })
    .where('sweeping_started_at', '<', cutoff)
    .select('id', 'sweep_attempts', 'address', 'asset');

  let reclaimed = 0;
  for (const row of stale as Array<{ id: number; sweep_attempts: number | null; address: string; asset: string }>) {
    const attempts = Number(row.sweep_attempts ?? 0) + 1;
    await markSweepFailed(row.id, attempts, 'STALE_SWEEP_RECLAIMED', env);
    reclaimed += 1;
    logger.warn(
      { depositId: row.id, address: row.address, asset: row.asset, attempts },
      '[CchainOrder] Reclaimed stale in-flight sweep'
    );
  }
  return reclaimed;
}
