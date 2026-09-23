import crypto from 'crypto';
import { getAddress, isAddress } from 'viem';
import db from '../db';
import { getQuote, getMinFee } from './priceService';
import { createSepayOrder } from './sepayPgService';
import { createNapasCheckout, cancelOrder as cancelNapasOrder } from './sepayNapasService';
import { fireCallback } from './callbackService';
import { DEFAULT_NATIVE_USDT_ADDRESS } from '../config/cchain';
import { disburseCchain } from './cchainPayoutService';
import { getPayoutAddress } from './cchainPayoutAccount';
import { getConfigNumber, getTokenConfig } from './configService';
import type { PartnerAuthContext } from './partnerService';
import { consumeReservation, releaseReservation, reserveForOrder, rollbackReservation } from './reservationService';
import type { DepositRequest, WithdrawalRequest, PayGateway } from '../models/types';
import type { AvaRampOrder, AvaRampPaymentInfo, AvaRampTimestamp } from '../models/avaramp';
import { OrderState } from '../models/types';
import { provisionCustodialWallet, isCChainCustodialEnabled } from './cchainWalletService';

export { DepositRequest, WithdrawalRequest, OrderState } from '../models/types';

/** Default asset code surfaced to clients when an order does not set one. */
const DEFAULT_ASSET_CODE = 'AVAX';

/** Order expiry duration in milliseconds. Defaults to 5 minutes. */
export const ORDER_EXPIRY_MS = (Number(process.env.ORDER_EXPIRY_MINUTES) || 5) * 60 * 1000;

/** Partner name whose withdrawals skip VND payout and VND liquidity reservation. */
const NO_PAYOUT_PARTNER_NAME = 'tx-bot';

function isNoPayoutPartnerName(name: string | undefined | null): boolean {
  return name === NO_PAYOUT_PARTNER_NAME;
}

function isSupportedToken(tokenAddress: string | null | undefined, assetCode: string): boolean {
  const code = (assetCode || '').trim().toUpperCase();
  const address = (tokenAddress || '').trim();
  // Native AVAX (no token contract) is addressed by the configured asset code.
  if (!address) {
    const configuredCode = (process.env.ASSET_CODE || 'AVAX').trim().toUpperCase();
    return code === configuredCode || code === 'AVAX' || code === 'USDT';
  }
  // ERC-20: accept the configured native USDT contract.
  const usdt = process.env.CCHAIN_NATIVE_USDT_ADDRESS?.trim() || DEFAULT_NATIVE_USDT_ADDRESS;
  return address.toLowerCase() === usdt.toLowerCase();
}

/**
 * The C-Chain address that buy orders pay out from. Resolved from config; an
 * empty string is returned when the payout wallet is not configured so order
 * creation never fails on a missing wallet.
 */
async function resolvePayoutAddress(): Promise<string> {
  try {
    return await getPayoutAddress();
  } catch (error) {
    console.error('[OrderService] Could not resolve C-Chain payout address:', (error as Error).message);
    return '';
  }
}

interface OrderRow {
  id: number;
  payment_code: string;
  direction: 'buy' | 'sell';
  usdt_amount: string | number;
  rate: string | number;
  net_vnd: string | number;
  fee_rate: string | number;
  fee_vnd: string | number;
  order_state: number;
  payment_status: string;
  processing_state?: number | null;
  transaction_hash: string | null;
  error_message: string | null;
  chain_id: number;
  token_address: string;
  asset_code: string;
  recipient: string | null;
  callback: string;
  payment_info: AvaRampPaymentInfo | Record<string, unknown> | string | null;
  cancelled_at?: Date | null;
  expired_at: Date | null;
  created_at: Date;
  updated_at: Date;
  va_number: string | null;
  transfer_content: string | null;
  amount: string | number | null;
  bank_short: string | null;

  last_webhook_id?: string | null;
  bank_id: string | null;
  bank_account_name: string | null;
  bank_account_no: string | null;
  partner_id: string | null;
  pay_gateway?: string | null;
  user_id?: number | null;
}

export interface CreateOptions {
  clientIp?: string;
  partner?: PartnerAuthContext;
  userId?: number;
}

export interface CreateDepositParams extends DepositRequest {
  _clientIp?: string;
}

function toTimestamp(date: Date | string | number): AvaRampTimestamp {
  const ms = new Date(date).getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000,
  };
}
async function buildPartnerAdjustedQuote(
  direction: 'buy' | 'sell',
  usdtAmount: number,
  asset: string,
  partner?: PartnerAuthContext,
): Promise<{
  direction: 'buy' | 'sell';
  usdt_amount: number;
  rate: number;
  original_rate: number;
  spread: number;
  gross_vnd: number;
  fee_rate: number;
  fee_vnd: number;
  net_vnd: number;
  note: string;
}> {
  const baseQuote = await getQuote(direction, usdtAmount, asset);
  const partnerFeeRate = partner ? (direction === 'buy' ? partner.fee_buy : partner.fee_sell) : 0;
  const fee_rate = baseQuote.fee_rate + partnerFeeRate;
  const minFee = await getMinFee(asset);
  const fee_vnd = Math.max(Math.round(baseQuote.gross_vnd * fee_rate), minFee);
  const net_vnd = direction === 'buy' ? baseQuote.gross_vnd + fee_vnd : baseQuote.gross_vnd - fee_vnd;
  const assetCode = asset.toUpperCase();
  const note = direction === 'buy'
    ? 'Bạn cần chuyển ' + net_vnd.toLocaleString('vi-VN') + ' VND để nhận ' + usdtAmount + ' ' + assetCode
    : 'Bạn nhận được ' + net_vnd.toLocaleString('vi-VN') + ' VND khi bán ' + usdtAmount + ' ' + assetCode;
  return { ...baseQuote, fee_rate, fee_vnd, net_vnd, note };
}

async function toApiOrder(
  order: OrderRow,
  overrides?: Partial<Pick<AvaRampOrder, 'body' | 'pay_data' | 'user_id' | 'client_ip' | 'outcome'>>
): Promise<AvaRampOrder> {
  const rate = typeof order.rate === 'string' ? Number(order.rate) : order.rate;
  const feeVnd = typeof order.fee_vnd === 'string' ? Number(order.fee_vnd) : order.fee_vnd;
  const expiry = order.expired_at ?? new Date(order.created_at).getTime() + ORDER_EXPIRY_MS;
  let paymentInfo: AvaRampPaymentInfo | null = null;
  if (order.payment_info && typeof order.payment_info === 'object') {
    paymentInfo = order.payment_info as AvaRampPaymentInfo;
  } else if (typeof order.payment_info === 'string') {
    try {
      paymentInfo = JSON.parse(order.payment_info) as AvaRampPaymentInfo;
    } catch {
      paymentInfo = null;
    }
  }

  const assetCode = (order.asset_code || DEFAULT_ASSET_CODE).toUpperCase();

  const netVnd = typeof order.net_vnd === 'string' ? Number(order.net_vnd) : order.net_vnd;

  const fallbackBankInfo = order.direction === 'sell'
    ? {
        bankName: order.bank_id ?? '',
        bankAccountName: order.bank_account_name ?? '',
        bankAccountNumber: order.bank_account_no ?? '',
        transferContent: order.payment_code,
        vaAmount: netVnd,
      }
    : {
        bankId: order.bank_short ?? '',
        bankAccountNumber: order.va_number ?? '',
        transferContent: order.transfer_content ?? '',
        vaAmount: order.amount ? Number(order.amount) : 0,
      };

  return {
    id: String(order.id),
    user_id: overrides?.user_id ?? '',
    order_type: order.direction,
    external_id: null,
    code: order.payment_code,
    provider: order.direction === 'buy' ? 'sepay' : 'chain',
    callback: order.callback,
    amount: typeof order.usdt_amount === 'string' ? parseFloat(order.usdt_amount) : order.usdt_amount,
    currency: assetCode === 'AVAX' ? 'AVAX' : assetCode,
    chain: 'cchain',
    rate,
    token_address: order.token_address,
    asset_code: order.asset_code || '',
    recipient: order.recipient ?? '',
    chain_id: order.chain_id,
    partner_id: order.partner_id ?? null,
    state: order.order_state,
    processing_state: order.processing_state ?? 0,
    body: overrides?.body ?? {
      bankInfo: fallbackBankInfo,
    },
    pay_data: overrides?.pay_data ?? null,
    payment_info: paymentInfo,
    expired_at: toTimestamp(expiry),
    created_at: toTimestamp(order.created_at),
    updated_at: toTimestamp(order.updated_at),
    client_ip: overrides?.client_ip ?? '',
    outcome: overrides?.outcome ?? '',
    net_vnd: netVnd,
    total_fee_vnd: feeVnd,
    transaction_hash: order.transaction_hash,
  };
}

export async function formatOrderResponse(order: OrderRow): Promise<AvaRampOrder> {
  return toApiOrder(order);
}

function generatePaymentCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(8);
  let code = 'DH';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % 36];
  return code;
}

function firstRow<T>(result: T | T[]): T {
  return (Array.isArray(result) ? result[0] : result) as T;
}

function firstInsertedId(result: unknown): number {
  if (Array.isArray(result)) return Number(result[0]);
  if (typeof result === 'object' && result !== null && 'id' in result) {
    return Number((result as { id: number | string }).id);
  }
  return Number(result);
}

/**
 * Derive payment_status from order_state for backward compatibility.
 * Keeps payment_status in sync until the column is fully deprecated.
 */
function derivePaymentStatus(orderState: number): string {
  if (orderState === OrderState.CANCELLED) return 'cancel';
  if (orderState === OrderState.FAILED) return 'failed';
  if (orderState >= OrderState.PROCESSING) return 'payment_received';
  return 'pending';
}

/**
 * Centralized order state transition. ALL order state changes MUST go through
 * this function to ensure payment_status stays in sync with order_state.
 */
async function transitionOrder(
  orderId: number,
  update: {
    order_state: number;
    processing_state?: number;
    transaction_hash?: string | null;
    last_webhook_id?: string;
    recipient?: string | null;
    error_message?: string;
    vnd_received?: number;
    payment_confirmed_at?: unknown;
    cancelled_at?: unknown;
    cancel_reason?: string | null;
  }
): Promise<OrderRow> {
  const dbUpdate: Record<string, unknown> = {
    ...update,
    payment_status: derivePaymentStatus(update.order_state),
  };

  // Remove undefined values so we don't overwrite with NULL
  for (const key of Object.keys(dbUpdate)) {
    if (dbUpdate[key] === undefined) delete dbUpdate[key];
  }

  const updated = await db('orders')
    .where({ id: orderId })
    .update(dbUpdate)
    .returning('*');

  return firstRow<OrderRow>(updated as OrderRow | OrderRow[]);
}

export async function createBuyOrder(
  usdt_amount: number,
  asset: string = DEFAULT_ASSET_CODE,
  paymentCode?: string,
  options?: {
    partner?: PartnerAuthContext;
    quote?: Awaited<ReturnType<typeof buildPartnerAdjustedQuote>>;
    pay_gateway?: PayGateway;
  },
) {
  const quote = options?.quote ?? await buildPartnerAdjustedQuote('buy', usdt_amount, asset, options?.partner);
  const payment_code = paymentCode || generatePaymentCode();
  const payGateway = options?.pay_gateway ?? 'bank';

  const sepayOrder = payGateway === 'napas'
    ? await createNapasCheckout({
        amount: quote.net_vnd,
        description: `Thanh toan don hang ${payment_code}`,
        invoice: payment_code,
      })
    : await createSepayOrder({
        payment_code,
        net_vnd: quote.net_vnd,
      });

  const inserted = await db('orders').insert({
    payment_code,
    direction: 'buy',
    usdt_amount: quote.usdt_amount,
    rate: quote.original_rate,  // have spread
    net_vnd: quote.net_vnd,  // have spread and fee_vnd
    fee_rate: quote.fee_rate,
    fee_vnd: quote.fee_vnd,
    payment_status: 'pending',
    va_number: sepayOrder.va_number,
    transfer_content: sepayOrder.transfer_content,
    amount: sepayOrder.amount,
    bank_short: sepayOrder.bank_info.bank_short_name,
    order_state: OrderState.CREATED,
    partner_id: options?.partner?.id ?? null,
    pay_gateway: payGateway,
  });
  const id = firstInsertedId(inserted);

  return { id, payment_code, sepayOrder, quote };
}

export async function confirmPayment(params: {
  payment_code: string;
  vnd_received: number;
  last_webhook_id?: string;
}): Promise<{ success: boolean; error?: string }> {
  const order = await db('orders')
    .where({ payment_code: params.payment_code, order_state: OrderState.CREATED })
    .first();

  if (!order) {
    return { success: false, error: 'ORDER_NOT_FOUND_OR_NOT_CREATED' };
  }

  // Guard: reject payment on expired orders
  if (isOrderExpired(order)) {
    console.log(`[OrderService] ⏭ Rejecting payment for expired order: ${params.payment_code}`);
    await performCancel(order, 'ORDER_EXPIRED');
    return { success: false, error: 'ORDER_EXPIRED' };
  }

  await transitionOrder(order.id, {
    order_state: OrderState.PROCESSING,
    vnd_received: params.vnd_received,
    payment_confirmed_at: db.fn.now(),
    last_webhook_id: params.last_webhook_id,
  });

  if (order.direction === 'buy') {
    await consumeReservation(params.payment_code);
  }

  if (order.direction === 'buy' && order.recipient) {
    const usdtAmount = order.usdt_amount.toString();
    const assetCode = order.asset_code || DEFAULT_ASSET_CODE;
    return await disburseCchain(order.id, order.recipient, usdtAmount, assetCode, order.token_address);
  }

  return { success: true };
}

export async function findPendingOrderByCode(payment_code: string) {
  return db('orders').where({ payment_code, order_state: OrderState.CREATED }).first();
}

export async function getOrderByCode(payment_code: string) {
  return db('orders').where({ payment_code }).first();
}

export async function getOrderById(id: number) {
  return db('orders').where({ id }).first();
}

export interface ListOrdersParams {
  partnerId?: string;
  userId?: number;
  limit: number;
  offset: number;
  direction?: 'buy' | 'sell';
}

export async function listOrders(params: ListOrdersParams): Promise<OrderRow[]> {
  let query = db('orders').select('*').orderBy('updated_at', 'desc');
  if (params.partnerId) {
    query = query.where({ partner_id: params.partnerId });
  }
  if (params.userId !== undefined) {
    query = query.where({ user_id: params.userId });
  }
  if (params.direction) {
    query = query.where({ direction: params.direction });
  }
  return await query.limit(params.limit).offset(params.offset);
}

export async function createDeposit(
  req: DepositRequest,
  options?: CreateOptions
): Promise<AvaRampOrder> {
  const tokenAddress = req.token_address || '';
  if (!req.asset_code || !isSupportedToken(tokenAddress, req.asset_code)) {
    throw new Error('UNSUPPORTED_TOKEN');
  }

  const minOrder = await getTokenConfig(req.asset_code, 'buy', 'min_order_amount');
  if (Number(req.amount) < minOrder) {
    throw new Error('MIN_ORDER_NOT_MET');
  }

  // Avalanche C-Chain is EVM: the recipient must be a valid 0x address.
  if (!req.recipient || !isAddress(req.recipient)) {
    console.error(`[OrderService] Recipient validation failed for ${req.recipient}`);
    throw new Error('RECIPIENT_INVALID_ADDRESS');
  }
  const recipient = getAddress(req.recipient);

  const maxOrder = await getTokenConfig(req.asset_code, 'buy', 'max_order_amount');
  if (Number(req.amount) > maxOrder) {
    throw new Error('MAX_ORDER_EXCEEDED');
  }

  const expiredAt = new Date(Date.now() + ORDER_EXPIRY_MS);
  const paymentCode = generatePaymentCode();
  const usdtAmount = Number(req.amount);

  const quote = await buildPartnerAdjustedQuote('buy', usdtAmount, req.asset_code, options?.partner);

  const reserveResult = await reserveForOrder({
    paymentCode,
    direction: 'buy',
    token: req.asset_code,
    amount: req.amount,
    vndAmount: quote.net_vnd,
    expiresAt: expiredAt,
  });
  if (!reserveResult.success) {
    throw new Error(reserveResult.error || 'INSUFFICIENT_LIQUIDITY');
  }

  let result: Awaited<ReturnType<typeof createBuyOrder>>;
  try {
    result = await createBuyOrder(usdtAmount, req.asset_code, paymentCode, { partner: options?.partner, quote, pay_gateway: req.pay_gateway ?? 'bank' });
  } catch (error) {
    await rollbackReservation(paymentCode);
    throw error;
  }

  let updated;
  try {
    updated = await db('orders')
      .where({ payment_code: result.payment_code })
      .update({
        chain_id: req.chain_id,
        token_address: req.token_address,
        asset_code: req.asset_code,
        recipient: recipient,
        callback: req.callback,
        order_state: OrderState.CREATED,
        processing_state: 10,
        expired_at: expiredAt,
        va_number: result.sepayOrder.va_number,
        transfer_content: result.sepayOrder.transfer_content,
        amount: result.sepayOrder.amount,
        ...(options?.userId !== undefined ? { user_id: options.userId } : {}),
      })
      .returning('*');
  } catch (error) {
    await rollbackReservation(paymentCode);
    throw error;
  }
  const order = firstRow<OrderRow>(updated as OrderRow | OrderRow[]);
  if (req.callback) {
    fireCallback(req.callback, order.id, 0, OrderState.CREATED, 0, 10).catch((err) => console.error('[OrderService] fireCallback failed:', err));
  }
  const walletAddress = await resolvePayoutAddress();
  return await toApiOrder(order as OrderRow, {
    user_id: req.user_id ?? '',
    client_ip: options?.clientIp ?? '',
    pay_data: {
      address: walletAddress,
      qr_link: result.sepayOrder.qr_code_url,
      qr_code: result.sepayOrder.qr_code_url,
    },
    body: {
      qr_link: result.sepayOrder.qr_code_url,
      qr_code: result.sepayOrder.qr_code_url,
      bankInfo: {
        bankId: result.sepayOrder.bank_info.bank_short_name,
        bankAccountNumber: result.sepayOrder.bank_info.account_number,
        transferContent: result.sepayOrder.transfer_content,
        vaAmount: result.sepayOrder.amount,
      },
    },
  });
}

export async function createWithdrawal(
  req: WithdrawalRequest,
  options?: CreateOptions
): Promise<AvaRampOrder> {
  const tokenAddress = req.token_address || '';
  if (!req.asset_code || !isSupportedToken(tokenAddress, req.asset_code)) {
    throw new Error('UNSUPPORTED_TOKEN');
  }
  const usdtAmount = Number(req.amount);
  const minOrder = await getTokenConfig(req.asset_code, 'sell', 'min_order_amount');
  if (usdtAmount < minOrder) {
    throw new Error('MIN_ORDER_NOT_MET');
  }
  const maxOrder = await getTokenConfig(req.asset_code, 'sell', 'max_order_amount');
  if (usdtAmount > maxOrder) {
    throw new Error('MAX_ORDER_EXCEEDED');
  }
  const quote = await buildPartnerAdjustedQuote('sell', usdtAmount, req.asset_code, options?.partner);
  const payment_code = generatePaymentCode();
  const expiredAt = new Date(Date.now() + ORDER_EXPIRY_MS);

  // Special partner: withdrawals do not pay out VND, so no VND liquidity is reserved.
  const skipPayout = isNoPayoutPartnerName(options?.partner?.name);
  if (!skipPayout) {
    const reserveResult = await reserveForOrder({
      paymentCode: payment_code,
      direction: 'sell',
      token: 'VND',
      amount: quote.net_vnd,
      vndAmount: quote.net_vnd,
      expiresAt: expiredAt,
    });
    if (!reserveResult.success) {
      throw new Error(reserveResult.error || 'INSUFFICIENT_LIQUIDITY');
    }
  }

  let inserted: unknown;
  try {
    inserted = await db('orders')
      .insert({
        payment_code,
        direction: 'sell',
        usdt_amount: quote.usdt_amount,
        rate: quote.rate,
        net_vnd: quote.net_vnd,
        fee_rate: quote.fee_rate,
        fee_vnd: quote.fee_vnd,
        payment_status: 'pending',
        order_state: OrderState.CREATED,
        processing_state: 10,
        chain_id: req.chain_id,
        token_address: tokenAddress,
        asset_code: req.asset_code,
        callback: req.callback,
        bank_id: req.payment_info.bank_id,
        bank_account_name: req.payment_info.full_name,
        bank_account_no: req.payment_info.account_number,
        payment_info: JSON.stringify(req.payment_info),
        expired_at: expiredAt,
        partner_id: options?.partner?.id ?? null,
        ...(options?.userId !== undefined ? { user_id: options.userId } : {}),
      });
  } catch (error) {
    await rollbackReservation(payment_code);
    throw error;
  }
  const order = await db('orders').where({ payment_code }).first<OrderRow>();
  if (!order) {
    throw new Error('Failed to create withdrawal order');
  }
  if (req.callback) {
    fireCallback(req.callback, order.id, 0, OrderState.CREATED, 0, 10).catch((err) => console.error('[OrderService] fireCallback failed:', err));
  }

  let depositedAddress = '';
  if (isCChainCustodialEnabled()) {
    try {
      depositedAddress = await provisionCustodialWallet(Number(order.id));
      await db('orders').where({ payment_code }).update({ recipient: depositedAddress });
    } catch (err) {
      console.error('[OrderService] custodial wallet provisioning failed (will use hot wallet):', (err as Error).message);
    }
  }

  const walletAddress = depositedAddress;
  return await toApiOrder(order as OrderRow, {
    user_id: req.user_id ?? '',
    client_ip: options?.clientIp ?? '',
    pay_data: { address: walletAddress },
    body: {
      bankInfo: {
        bankName: req.payment_info.bank_id,
        bankAccountName: req.payment_info.full_name,
        bankAccountNumber: req.payment_info.account_number,
        transferContent: payment_code,
        vaAmount: quote.net_vnd,
      },
    },
  });
}

/** Check whether an order has passed its expiry time. */
function isOrderExpired(order: OrderRow): boolean {
  const expiry = order.expired_at
    ? new Date(order.expired_at).getTime()
    : new Date(order.created_at).getTime() + ORDER_EXPIRY_MS;
  return Date.now() >= expiry;
}

/**
 * Auto-cancel all CREATED orders that have passed their expiry time.
 * Called by the expiry scheduler on a periodic interval.
 */
export async function cancelExpiredOrders(): Promise<number> {
  const now = new Date();
  const fallbackCutoff = new Date(Date.now() - ORDER_EXPIRY_MS);

  // Orders with explicit expired_at that have passed, OR
  // orders without expired_at whose created_at + ORDER_EXPIRY_MS has passed
  const expiredOrders: OrderRow[] = await db('orders')
    .where('order_state', OrderState.CREATED)
    .where(function (this: any) {
      this.where('expired_at', '<=', now)
        .orWhere(function (this: any) {
          this.whereNull('expired_at').andWhere('created_at', '<=', fallbackCutoff);
        });
    });

  let cancelled = 0;
  for (const order of expiredOrders) {
    const result = await performCancel(order, 'ORDER_EXPIRED');
    if (result.data) {
      cancelled++;
      await rollbackReservation(order.payment_code);
    }
  }
  return cancelled;
}

interface CancelResult {
  data?: {
    payment_code: string;
    order_state: number;
    cancelled_at: string;
  };
  error?: string;
}

async function performCancel(order: OrderRow, reason?: string): Promise<CancelResult> {
  const currentState = order.order_state || 0;

  // Only CREATED orders can be cancelled
  if (currentState !== OrderState.CREATED) {
    return { error: 'CANCEL_NOT_ALLOWED' };
  }

  // Block cancellation if payment webhook already received
  if (order.last_webhook_id) {
    return { error: 'CANCEL_NOT_ALLOWED' };
  }

  // Cancel the SePay PG checkout first for NAPAS orders; never block on it
  if (order.pay_gateway === 'napas') {
    try {
      await cancelNapasOrder(order.payment_code);
    } catch (err) {
      console.error(`[OrderService] SePay pgapi cancel failed for ${order.payment_code}:`, err);
    }
  }

  const updated = await transitionOrder(order.id, {
    order_state: OrderState.CANCELLED,
    cancelled_at: db.fn.now(),
    cancel_reason: reason || null,
  });

  // Release reservation for both buy and sell orders
  await releaseReservation(order.payment_code);

  if (order.callback) {
    fireCallback(order.callback, order.id, currentState, OrderState.CANCELLED, order.processing_state || 0, order.processing_state || 0).catch((err) => console.error('[OrderService] fireCallback failed:', err));
  }

  return {
    data: {
      payment_code: updated.payment_code,
      order_state: updated.order_state,
      cancelled_at: updated.cancelled_at?.toISOString() || new Date().toISOString(),
    },
  };
}

export async function cancelOrder(paymentCode: string, reason?: string): Promise<CancelResult> {
  const order = await db('orders').where({ payment_code: paymentCode }).first();
  if (!order) {
    return { error: 'ORDER_NOT_FOUND' };
  }
  return performCancel(order, reason);
}

export async function cancelOrderById(orderId: number, reason?: string): Promise<CancelResult> {
  const order = await db('orders').where({ id: orderId }).first();
  if (!order) {
    return { error: 'ORDER_NOT_FOUND' };
  }
  return performCancel(order, reason);
}

export async function updateOrderState(paymentCode: string, newState: number | string): Promise<void> {
  const order = await db('orders').where({ payment_code: paymentCode }).first();
  if (!order) return;

  const oldState = order.order_state || 0;
  const oldProcessingState = order.processing_state || 0;
  const stateNum = typeof newState === 'string' ? Number(newState) : newState;
  await transitionOrder(order.id, { order_state: stateNum });

  if (order.callback) {
    fireCallback(order.callback, order.id, oldState, stateNum, oldProcessingState, oldProcessingState).catch((err) => console.error('[OrderService] fireCallback failed:', err));
  }
}

export async function bypassPayment(adminKey: string, orderId: number): Promise<{ success?: boolean; error?: string; hash?: string }> {
  const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!bootstrapPassword || adminKey !== bootstrapPassword) {
    return { error: 'INVALID_ADMIN_CODE' };
  }

  const order = await db('orders').where({ id: orderId }).first();
  if (!order) {
    return { error: 'ORDER_NOT_FOUND' };
  }

  if (order.direction !== 'buy') {
    return { error: 'NOT_BUY_ORDER' };
  }

  const currentState = order.order_state || 0;
  if (currentState !== OrderState.CREATED) {
    return { error: 'ORDER_NOT_ELIGIBLE' };
  }

  const usdtAmount = order.usdt_amount.toString();
  const assetCode = order.asset_code || DEFAULT_ASSET_CODE;
  const tokenAddress = order.token_address || '';

  const txHash = `bypass-${Date.now()}`;
  const [insertedWebhookLog] = await db('webhook_logs').insert({
    tx_hash: txHash,
    source: 'admin-bypass',
    body: JSON.stringify({ bypass: true, orderId, txHash }),
  }).returning('id');
  const webhookLogId = Number((insertedWebhookLog as any).id ?? insertedWebhookLog);

  // Transition to PROCESSING state
  await transitionOrder(orderId, {
    order_state: OrderState.PROCESSING,
    vnd_received: Number(order.net_vnd),
    payment_confirmed_at: db.fn.now(),
    last_webhook_id: String(webhookLogId),
  });

  // Consume reservation
  await consumeReservation(order.payment_code);

  // Execute the C-Chain payout directly (not via Kafka) for an immediate result.
  const disburseResult = await disburseCchain(orderId, order.recipient, usdtAmount, assetCode, tokenAddress);

  if (disburseResult.success) {
    return { success: true, hash: disburseResult.hash };
  } else {
    return { success: false, error: disburseResult.error };
  }
}

