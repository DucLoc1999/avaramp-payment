import 'dotenv/config';
import Redis from 'ioredis';
import db from '../db';
import { getAccountBalance } from './payoutService';
import { getPayoutAddress } from './cchainPayoutAccount';
import { getBalance, getUsdtBalance } from './cchainRpcService';
import { loadCchainConfig } from '../config/cchain';
import { decimalsForAsset, toUnits, fromUnits } from './cchainUnits';
import { OrderState } from '../models/types';

const BALANCE_TTL_SEC = 15;

let redis: Redis | null = null;
let enabled = false;
let ready = false;

/** The chain token the reservation system tracks on the C-Chain (default AVAX). */
function chainToken(): string {
  return (process.env.ASSET_CODE || 'AVAX').trim().toUpperCase();
}

/** Whether a token is a C-Chain asset tracked by the reservation system. */
function isCchainToken(token: string): boolean {
  const code = token.toUpperCase();
  return code === 'AVAX' || code === 'USDT' || code === chainToken();
}

function toTokenUnits(token: string, input: string | number): bigint {
  const raw = String(input).trim();
  if (token === 'VND') return BigInt(Math.round(Number(raw) || 0));
  return toUnits(raw, decimalsForAsset(token, null));
}

function fromTokenUnits(token: string, units: bigint): string {
  return token === 'VND' ? units.toString() : fromUnits(units, decimalsForAsset(token, null));
}

function parseBufferUnits(token: string): bigint {
  const raw = process.env[`RESERVATION_BUFFER_${token}`];
  if (token === 'VND') return BigInt(Math.round(Number(raw ?? '0') || 0));
  try {
    return toUnits(raw ?? '1', decimalsForAsset(token, null));
  } catch {
    return toUnits('1', decimalsForAsset(token, null));
  }
}

function balanceKey(token: string): string {
  return `wallet:balance:${token.toUpperCase()}`;
}

function totalKey(token: string): string {
  return `reserved:total:${token.toUpperCase()}`;
}

function reservationKey(direction: string, paymentCode: string): string {
  return `reservation:${direction}:${paymentCode}`;
}

function mapKey(paymentCode: string): string {
  return `reservation:map:${paymentCode}`;
}

const expiryZset = 'reservations:expiry';

function isEnabled(): boolean {
  return enabled && !!redis;
}

async function pruneExpired(nowMs: number, limit = 50): Promise<void> {
  if (!isEnabled()) return;
  const client = redis!;
  const expiredMembers = await client.zrangebyscore(expiryZset, 0, nowMs, 'LIMIT', 0, limit);
  for (const member of expiredMembers) {
    const colonIdx = member.indexOf(':');
    if (colonIdx === -1) continue;
    const direction = member.slice(0, colonIdx);
    const paymentCode = member.slice(colonIdx + 1);
    await releaseReservationByKey(reservationKey(direction, paymentCode), direction, paymentCode, 'expired');
  }
}

async function releaseReservationByKey(
  resKey: string,
  direction: string,
  paymentCode: string,
  reason: 'expired' | 'manual' | 'rollback'
): Promise<boolean> {
  if (!isEnabled()) return false;
  const client = redis!;
  for (let i = 0; i < 3; i++) {
    await client.watch(resKey);
    const data = await client.hgetall(resKey);
    if (!data || !data.state || !data.token || !data.amount_units) {
      await client.unwatch();
      await client.zrem(expiryZset, `${direction}:${paymentCode}`);
      return false;
    }
    if (data.state !== 'reserved') {
      await client.unwatch();
      await client.zrem(expiryZset, `${direction}:${paymentCode}`);
      return false;
    }
    const amountUnits = BigInt(data.amount_units);
    const tx = client.multi();
    tx.hset(resKey, 'state', 'released', 'release_reason', reason, 'released_at', String(Date.now()));
    tx.del(resKey);
    tx.decrby(totalKey(data.token), amountUnits.toString());
    tx.del(mapKey(paymentCode));
    tx.zrem(expiryZset, `${direction}:${paymentCode}`);
    const out = await tx.exec();
    if (out) return true;
  }
  return false;
}

async function refreshBalanceFromApi(token: string): Promise<string | null> {
  if (token === 'VND') {
    const result = await getAccountBalance();
    console.log(`[Reservation] VND balance (PayOS): success=${result.success}, availableBalance=${result.availableBalance}, error=${result.error}`);
    if (!result.success) return null;
    return String(Math.round(result.availableBalance ?? 0));
  }

  if (isCchainToken(token)) {
    const walletAddress = await getPayoutAddress();
    const code = token.toUpperCase();
    const decimals = decimalsForAsset(code, null);
    if (code === 'USDT') {
      const cfg = loadCchainConfig();
      const gasBalance = await getBalance(walletAddress);
      if (gasBalance < cfg.avaxGasReserveWei) {
        console.warn(
          `[Reservation] USDT payout wallet ${walletAddress} has insufficient AVAX gas: ${gasBalance} < ${cfg.avaxGasReserveWei}`
        );
        return '0';
      }
      const balance = await getUsdtBalance(walletAddress);
      console.log(`[Reservation] ${token} balance from C-Chain: ${fromUnits(balance, decimals)} for wallet ${walletAddress}`);
      return balance.toString();
    }
    const balance = await getBalance(walletAddress);
    console.log(`[Reservation] ${token} balance from C-Chain: ${fromUnits(balance, decimals)} for wallet ${walletAddress}`);
    return balance.toString();
  }

  return null;
}

export async function initReservationService(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || process.env.RESERVATION_ENABLED === 'false') {
    enabled = false;
    ready = false;
    return;
  }
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });
  enabled = true;
  await reconcileReservedTotalsFromDb();
  ready = true;
}

export function startReservationSchedulers(): NodeJS.Timeout[] {
  if (!isEnabled()) return [];
  const reconcileMs = Number(process.env.RESERVATION_RECONCILE_INTERVAL_MS || 60000);
  const tick = () => {
    reconcileReservedTotalsFromDb().catch((err) => console.error('[Reservation] reconcile failed:', err));
    syncVndBalance().catch((err) => console.error('[Reservation] syncVndBalance failed:', err));
    syncWalletBalances().catch((err) => console.error('[Reservation] syncWalletBalances failed:', err));
  };
  const c = setInterval(tick, reconcileMs);
  c.unref();
  tick(); // sync balances + reconcile immediately at startup
  return [c];
}

export async function shutdownReservationService(): Promise<void> {
  if (redis) await redis.quit();
  redis = null;
  enabled = false;
  ready = false;
}

export interface ReserveResult {
  success: boolean;
  error?: 'RESERVATION_NOT_READY' | 'INSUFFICIENT_LIQUIDITY' | 'RESERVATION_CONFLICT' | 'INSUFFICIENT_GAS';
}

export async function reserveForOrder(params: {
  paymentCode: string;
  direction: 'buy' | 'sell';
  token: string;
  amount: string | number;
  vndAmount: string | number;
  expiresAt: Date;
}): Promise<ReserveResult> {
  if (!isEnabled()) return { success: true };
  if (!ready) return { success: false, error: 'RESERVATION_NOT_READY' };
  const client = redis!;
  const token = params.token.toUpperCase();
  const isVnd = token === 'VND';
  const amountUnits = toTokenUnits(token, params.amount);
  const vndAmountUnits = BigInt(Math.round(Number(params.vndAmount) || 0));
  const bufferUnits = parseBufferUnits(token);
  const now = Date.now();

  // USDT buys need AVAX to pay payout gas; fail early when the reserve is gone.
  if (token === 'USDT') {
    try {
      const cfg = loadCchainConfig();
      const wallet = await getPayoutAddress();
      const gasBalance = await getBalance(wallet);
      if (gasBalance < cfg.avaxGasReserveWei) {
        console.warn(`[Reservation] INSUFFICIENT_GAS: ${gasBalance} < ${cfg.avaxGasReserveWei}`);
        return { success: false, error: 'INSUFFICIENT_GAS' };
      }
    } catch (err) {
      console.warn('[Reservation] USDT gas check skipped:', (err as Error).message);
    }
  }

  await pruneExpired(now, 100);

  let balanceRaw = await client.get(balanceKey(token));
  const walletLabel = await (async () => {
    try { return await getPayoutAddress(); } catch { return '(not set)'; }
  })();

  console.log(`[Reservation] reserveForOrder: paymentCode=${params.paymentCode}, direction=${params.direction}, token=${token}, amount=${params.amount}`);
  console.log(`[Reservation] reserveForOrder: cached balanceRaw=${balanceRaw}, walletAddress=${walletLabel}`);

  if (!balanceRaw) {
    console.log(`[Reservation] No cached balance for ${token}, refreshing from API...`);
    const fresh = await refreshBalanceFromApi(token);
    console.log(`[Reservation] refreshBalanceFromApi(${token}) = ${fresh}`);
    if (fresh === null) {
      console.log(`[Reservation] refreshBalanceFromApi returned null, returning RESERVATION_NOT_READY`);
      return { success: false, error: 'RESERVATION_NOT_READY' };
    }
    balanceRaw = isVnd ? String(Math.round(Number(fresh) || 0)) : fresh;
    await client.set(balanceKey(token), balanceRaw, 'EX', BALANCE_TTL_SEC);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const paymentMap = mapKey(params.paymentCode);
    await client.watch(balanceKey(token), totalKey(token), paymentMap);
    const [currentBalance, reservedRaw, existing] = await client.mget(balanceKey(token), totalKey(token), paymentMap);

    console.log(`[Reservation] reserveForOrder attempt ${attempt}: paymentCode=${params.paymentCode}, token=${token}, amount=${params.amount}, buffer=${process.env[`RESERVATION_BUFFER_${token}`] ?? (isVnd ? '0' : '1')}`);
    console.log(`[Reservation]   Redis state: currentBalance=${currentBalance}, reservedRaw=${reservedRaw}, existing=${existing}`);
    console.log(`[Reservation]   walletAddress=${walletLabel}`);

    if (existing) {
      await client.unwatch();
      return { success: true };
    }
    if (!currentBalance) {
      await client.unwatch();
      return { success: false, error: 'RESERVATION_NOT_READY' };
    }
    const balanceUnits = BigInt(currentBalance);
    const reservedUnits = BigInt(reservedRaw ?? '0');
    const available = balanceUnits - reservedUnits - bufferUnits;
    console.log(`[Reservation]   liquidity check: balanceUnits=${balanceUnits}, reservedUnits=${reservedUnits}, bufferUnits=${bufferUnits}, available=${available}, needed=${amountUnits}`);
    if (available < amountUnits) {
      console.log(`[Reservation] INSUFFICIENT_LIQUIDITY: available=${available} < amountUnits=${amountUnits} for token=${token}`);
      await client.unwatch();
      return { success: false, error: 'INSUFFICIENT_LIQUIDITY' };
    }
    const resKey = reservationKey(params.direction, params.paymentCode);
    const expiresAtMs = params.expiresAt.getTime() + 5000;
    const tx = client.multi();
    tx.incrby(totalKey(token), amountUnits.toString());
    tx.hset(resKey, {
      payment_code: params.paymentCode,
      direction: params.direction,
      token,
      amount_units: amountUnits.toString(),
      vnd_amount_units: vndAmountUnits.toString(),
      state: 'reserved',
      reserved_at: String(now),
      expires_at: String(expiresAtMs),
    });
    tx.pexpireat(resKey, expiresAtMs);
    tx.set(paymentMap, params.direction, 'PXAT', expiresAtMs);
    tx.zadd(expiryZset, String(expiresAtMs), `${params.direction}:${params.paymentCode}`);
    const out = await tx.exec();
    if (out) return { success: true };
  }
  return { success: false, error: 'RESERVATION_CONFLICT' };
}

async function readReservation(paymentCode: string): Promise<{ direction: string; resKey: string } | null> {
  if (!isEnabled()) return null;
  const direction = await redis!.get(mapKey(paymentCode));
  if (!direction) return null;
  return { direction, resKey: reservationKey(direction, paymentCode) };
}

export async function consumeReservation(paymentCode: string): Promise<boolean> {
  if (!isEnabled()) return true;
  const info = await readReservation(paymentCode);
  if (!info) return false;
  const { direction, resKey } = info;
  const client = redis!;
  for (let i = 0; i < 3; i++) {
    await client.watch(resKey);
    const data = await client.hgetall(resKey);
    if (!data || data.state !== 'reserved' || !data.token || !data.amount_units) {
      await client.unwatch();
      return false;
    }
    const tx = client.multi();
    tx.hset(resKey, 'state', 'consumed', 'consumed_at', String(Date.now()));
    tx.del(resKey);
    tx.decrby(totalKey(data.token), data.amount_units);
    tx.del(mapKey(paymentCode));
    tx.zrem(expiryZset, `${direction}:${paymentCode}`);
    const out = await tx.exec();
    if (out) return true;
  }
  return false;
}

export async function releaseReservation(paymentCode: string): Promise<boolean> {
  if (!isEnabled()) return true;
  const info = await readReservation(paymentCode);
  if (!info) return false;
  return releaseReservationByKey(info.resKey, info.direction, paymentCode, 'manual');
}

export async function rollbackReservation(paymentCode: string): Promise<boolean> {
  if (!isEnabled()) return true;
  const info = await readReservation(paymentCode);
  if (!info) return false;
  return releaseReservationByKey(info.resKey, info.direction, paymentCode, 'rollback');
}

export async function syncWalletBalances(): Promise<void> {
  if (!isEnabled()) return;
  const client = redis!;
  let walletAddress: `0x${string}`;
  try {
    walletAddress = await getPayoutAddress();
  } catch {
    console.warn('[Reservation] syncWalletBalances: payout wallet address not resolvable (KMS/config), skipping');
    ready = false;
    return;
  }
  const token = chainToken();
  const decimals = decimalsForAsset(token, null);
  const balance = token.toUpperCase() === 'USDT'
    ? await getUsdtBalance(walletAddress)
    : await getBalance(walletAddress);
  console.log(`[Reservation] syncWalletBalances: ${token}=${fromUnits(balance, decimals)} for wallet=${walletAddress}`);
  await client.set(balanceKey(token), balance.toString(), 'EX', BALANCE_TTL_SEC);
  ready = true;
}

export async function syncVndBalance(): Promise<void> {
  if (!isEnabled()) return;
  const client = redis!;
  const result = await getAccountBalance();
  if (!result.success) {
    console.error('[Reservation] syncVndBalance failed:', result.error);
    return;
  }
  const rawBalance = result.availableBalance ?? 0;
  console.log(`[Reservation] syncVndBalance: availableBalance=${rawBalance}`);
  await client.set(balanceKey('VND'), String(Math.round(rawBalance)), 'EX', BALANCE_TTL_SEC);
}

export async function reconcileReservedTotalsFromDb(): Promise<void> {
  if (!isEnabled()) return;
  const client = redis!;

  const buyRows = await db('orders')
    .select('asset_code')
    .sum<{ asset_code: string; total: string }[]>({ total: 'usdt_amount' })
    .where({ direction: 'buy', order_state: OrderState.CREATED })
    .andWhere('expired_at', '>', db.fn.now())
    .groupBy('asset_code');

  const totals = new Map<string, bigint>([[chainToken(), 0n], ['VND', 0n]]);
  for (const row of buyRows) {
    const token = (row.asset_code || chainToken()).toUpperCase();
    if (!totals.has(token)) continue;
    totals.set(token, token === 'VND'
      ? BigInt(Math.round(Number(row.total || 0) || 0))
      : toTokenUnits(token, row.total || '0'));
  }

  const sellKeys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', 'reservation:sell:*', 'COUNT', 100);
    cursor = nextCursor;
    sellKeys.push(...keys);
  } while (cursor !== '0');

  if (sellKeys.length > 0) {
    const pipe = client.multi();
    for (const key of sellKeys) {
      pipe.hget(key, 'vnd_amount_units');
    }
    const results = await pipe.exec();
    if (results) {
      let vndTotal = 0n;
      for (const [err, val] of results) {
        if (!err && val) vndTotal += BigInt(val as string);
      }
      totals.set('VND', vndTotal);
    }
  }

  console.log(`[Reservation] reconcileReservedTotalsFromDb: ${chainToken()}=${totals.get(chainToken())}, VND=${totals.get('VND')}`);

  const tx = client.multi();
  for (const [token, value] of totals.entries()) {
    tx.set(totalKey(token), value.toString());
  }
  await tx.exec();
}

export function formatUnitsForLog(value: bigint): string {
  return fromUnits(value, decimalsForAsset(chainToken(), null));
}