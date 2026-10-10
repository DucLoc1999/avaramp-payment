import db from '../db';
import { OrderState, ProcessingState } from '../models/types';
import { fireCallback } from './callbackService';
import { executePayout } from './payoutService';
import { consumeReservation, releaseReservation } from './reservationService';
import { isNoPayoutPartnerName } from './partnerPolicy';
import { withKeyLock } from '../utils/nonceLock';
import { logger } from '../config/logger';

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

interface SellPayoutOrderRow {
  id: number;
  payment_code: string;
  order_state: number;
  processing_state: number | null;
  net_vnd: string | number;
  bank_id: string | null;
  bank_account_name: string | null;
  bank_account_no: string | null;
  partner_id: string | null;
  callback: string | null;
  transaction_hash: string | null;
  vnd_payout_attempts: number | null;
}

/** Whether the sell VND payout pipeline is enabled. Off by default: it moves money. */
export function isSellPayoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CCHAIN_SELL_PAYOUT_ENABLED === 'true';
}

function maxAttempts(env: NodeJS.ProcessEnv): number {
  const raw = env.CCHAIN_SELL_PAYOUT_MAX_ATTEMPTS?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_ATTEMPTS;
}

function retryDelayMs(attempts: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
}

async function isNoPayoutOrder(partnerId: string | null): Promise<boolean> {
  if (!partnerId) return false;
  const partner = await db('partners').where({ id: partnerId }).first<{ name: string }>();
  return isNoPayoutPartnerName(partner?.name);
}

/** Mark a swept sell order paid, consume its VND reservation, and fire the callback. */
async function markSellPaid(order: SellPayoutOrderRow, txId: string | null): Promise<void> {
  const previousState = order.processing_state ?? ProcessingState.SELL_SWEPT_AWAITING_PAYOUT;
  await db('orders')
    .where({ id: order.id })
    .update({
      order_state: OrderState.COMPLETED,
      processing_state: ProcessingState.SELL_PAYOUT_COMPLETED,
      vnd_payout_tx_id: txId,
      vnd_payout_error: null,
      vnd_payout_at: new Date(),
      next_vnd_payout_at: null,
      updated_at: new Date(),
    });

  await consumeReservation(order.payment_code);

  if (order.callback) {
    fireCallback(
      order.callback,
      order.id,
      OrderState.PROCESSING,
      OrderState.COMPLETED,
      previousState,
      ProcessingState.SELL_PAYOUT_COMPLETED,
      order.transaction_hash ?? null
    ).catch((err) => logger.error({ error: (err as Error).message }, '[SellPayout] fireCallback failed'));
  }

  logger.info(
    { orderId: order.id, paymentCode: order.payment_code, vndPayoutTxId: txId },
    '[SellPayout] Sell order VND payout completed'
  );
}

/** Mark a no-payout partner order complete without disbursing VND. */
async function markSellNoPayout(order: SellPayoutOrderRow): Promise<void> {
  const previousState = order.processing_state ?? ProcessingState.SELL_SWEPT_AWAITING_PAYOUT;
  await db('orders')
    .where({ id: order.id })
    .update({
      order_state: OrderState.COMPLETED,
      processing_state: ProcessingState.SELL_NO_PAYOUT,
      vnd_payout_error: null,
      next_vnd_payout_at: null,
      updated_at: new Date(),
    });

  await releaseReservation(order.payment_code);

  if (order.callback) {
    fireCallback(
      order.callback,
      order.id,
      OrderState.PROCESSING,
      OrderState.COMPLETED,
      previousState,
      ProcessingState.SELL_NO_PAYOUT,
      order.transaction_hash ?? null
    ).catch((err) => logger.error({ error: (err as Error).message }, '[SellPayout] fireCallback failed'));
  }
}

/** Record a VND payout failure and schedule a retry unless the budget is exhausted. */
async function markSellPayoutFailed(
  order: SellPayoutOrderRow,
  attempts: number,
  error: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const terminal = attempts >= maxAttempts(env);
  await db('orders')
    .where({ id: order.id })
    .update({
      processing_state: ProcessingState.SELL_PAYOUT_FAILED,
      vnd_payout_error: error.slice(0, 500),
      next_vnd_payout_at: terminal ? null : new Date(Date.now() + retryDelayMs(attempts)),
      updated_at: new Date(),
    });

  if (terminal) {
    // Funds were swept to the Master wallet but the seller was not paid. This
    // needs a human: it is deliberately left in SELL_PAYOUT_FAILED, not FAILED,
    // so the buy reconciler cannot touch it.
    logger.error(
      { orderId: order.id, paymentCode: order.payment_code, attempts, error },
      '[SellPayout] VND payout exhausted retries; manual intervention required'
    );
  } else {
    logger.warn(
      { orderId: order.id, paymentCode: order.payment_code, attempts, error },
      '[SellPayout] VND payout failed; scheduled retry'
    );
  }
}

/**
 * Disburse the VND owed for an already-swept sell order. Idempotent: a terminal
 * order is skipped, a stable PayOS `referenceId` makes a retry a no-op upstream,
 * and the reservation is consumed only once.
 */
export async function runSellPayout(
  orderId: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  // The inline sweep completion and the reconciler can both target one order. The
  // per-order queue (plus the stable PayOS referenceId) keeps a payout single-shot.
  return withKeyLock(`sell-payout:${orderId}`, () => runSellPayoutLocked(orderId, env));
}

async function runSellPayoutLocked(
  orderId: number,
  env: NodeJS.ProcessEnv
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const order = await db('orders').where({ id: orderId }).first<SellPayoutOrderRow>();
  if (!order) return { success: false, error: 'ORDER_NOT_FOUND' };

  if (
    order.processing_state === ProcessingState.SELL_PAYOUT_COMPLETED ||
    order.processing_state === ProcessingState.SELL_NO_PAYOUT
  ) {
    return { success: true, skipped: true };
  }
  if (
    order.processing_state !== ProcessingState.SELL_SWEPT_AWAITING_PAYOUT &&
    order.processing_state !== ProcessingState.SELL_PAYOUT_FAILED
  ) {
    return { success: false, error: `NOT_ELIGIBLE:${order.processing_state}` };
  }

  if (await isNoPayoutOrder(order.partner_id)) {
    await markSellNoPayout(order);
    return { success: true };
  }

  const attempts = Number(order.vnd_payout_attempts ?? 0) + 1;
  const referenceId = `payout_${order.id}`;

  // Claim the attempt before calling out, so a crash mid-payout still leaves the
  // reference and attempt count on the row.
  await db('orders')
    .where({ id: order.id })
    .update({
      vnd_payout_ref: referenceId,
      vnd_payout_attempts: attempts,
      processing_state: ProcessingState.SELL_SWEPT_AWAITING_PAYOUT,
      next_vnd_payout_at: null,
      updated_at: new Date(),
    });

  const result = await executePayout({
    orderId: order.id,
    amount: Number(order.net_vnd),
    bankId: String(order.bank_id ?? ''),
    bankAccountName: order.bank_account_name ?? '',
    bankAccountNo: order.bank_account_no ?? '',
    description: `Withdrawal ${order.payment_code}`,
    referenceId,
  });

  if (result.success) {
    await markSellPaid(order, result.transactionId ?? null);
    return { success: true };
  }

  await markSellPayoutFailed(order, attempts, result.error ?? 'VND_PAYOUT_FAILED', env);
  return { success: false, error: result.error };
}

/**
 * Retry sell payouts stuck in `SELL_SWEPT_AWAITING_PAYOUT` or
 * `SELL_PAYOUT_FAILED` whose backoff has elapsed. Mirrors the buy reconciler so
 * a crash between sweep and disbursement cannot silently strand a seller.
 */
export async function sweepStuckSellPayouts(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!isSellPayoutEnabled(env)) return 0;

  const rows = await db('orders')
    .where('direction', 'sell')
    .whereIn('processing_state', [
      ProcessingState.SELL_SWEPT_AWAITING_PAYOUT,
      ProcessingState.SELL_PAYOUT_FAILED,
    ])
    .where((qb) => qb.whereNull('next_vnd_payout_at').orWhere('next_vnd_payout_at', '<=', new Date()))
    .select('id');

  let processed = 0;
  for (const row of rows as Array<{ id: number }>) {
    try {
      const result = await runSellPayout(row.id, env);
      if (!result.skipped) processed += 1;
    } catch (error) {
      logger.error(
        { orderId: row.id, error: (error as Error).message },
        '[SellPayout] Reconciler failed to process order'
      );
    }
  }
  return processed;
}

/** Periodically retry stuck sell payouts. No-op (and does not schedule) when disabled. */
export function startSellPayoutReconciler(env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  if (!isSellPayoutEnabled(env)) {
    logger.info('[SellPayout] VND payout pipeline disabled (CCHAIN_SELL_PAYOUT_ENABLED != true)');
    return null;
  }

  const intervalMs = Number(env.CCHAIN_SELL_PAYOUT_RECONCILE_INTERVAL_MS || 60_000);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const recovered = await sweepStuckSellPayouts(env);
      if (recovered > 0) {
        logger.info({ recovered }, '[SellPayout] Reconciler processed stuck sell payouts');
      }
    } catch (error) {
      logger.error({ error: (error as Error).message }, '[SellPayout] Reconciler error');
    } finally {
      running = false;
    }
  };

  logger.info({ intervalMs }, '[SellPayout] Reconciler started');
  void tick();
  return setInterval(() => void tick(), intervalMs);
}
