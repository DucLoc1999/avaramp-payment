import db from '../db';

type ConfigKey = string;

export interface TokenSideConfig {
  spread: number;
  fee_rate: number;
  min_fee: number;
  min_order_amount: number;
  max_order_amount: number;
  source?: string;
}

const cache = new Map<ConfigKey, string>();
let cacheLoaded = false;

async function loadFromDb(): Promise<void> {
  const rows = await db('config').select('key', 'value');
  for (const row of rows) cache.set(row.key, row.value);
}

async function load(): Promise<void> {
  if (!cacheLoaded) {
    await loadFromDb();
    cacheLoaded = true;
  }
}

export async function refresh(): Promise<void> {
  cache.clear();
  await loadFromDb();
  cacheLoaded = true;
}

function envFallback(key: ConfigKey, fallback: number): number {
  const envMap: Record<string, string> = {
    spread_buy: 'SPREAD_BUY',
    spread_sell: 'SPREAD_SELL',
    fee_rate_buy: 'FEE_RATE_BUY',
    fee_rate_sell: 'FEE_RATE_SELL',
    usdt_spread_buy: 'USDT_SPREAD_BUY',
    usdt_spread_sell: 'USDT_SPREAD_SELL',
    usdt_fee_rate_buy: 'USDT_FEE_RATE_BUY',
    usdt_fee_rate_sell: 'USDT_FEE_RATE_SELL',
    avax_spread_buy: 'AVAX_SPREAD_BUY',
    avax_spread_sell: 'AVAX_SPREAD_SELL',
    avax_fee_rate_buy: 'AVAX_FEE_RATE_BUY',
    avax_fee_rate_sell: 'AVAX_FEE_RATE_SELL',
    usdt_min_fee: 'USDT_MIN_FEE_VND',
    avax_min_fee: 'AVAX_MIN_FEE_VND',
    min_fee_vnd: 'MIN_FEE_VND',
  };
  const envKey = envMap[key] || key.toUpperCase().replace(/[.-]/g, '_');
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const parsed = Number(envVal);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

export async function getConfig(key: ConfigKey): Promise<string | undefined> {
  await load();
  const val = cache.get(key);
  if (val !== undefined) return val;
  return undefined;
}

export async function getConfigNumber(key: ConfigKey, fallback: number): Promise<number> {
  const val = await getConfig(key);
  if (val !== undefined) {
    const parsed = Number(val);
    if (!isNaN(parsed)) return parsed;
    console.warn(`[ConfigService] Unparseable value for key="${key}" val="${val}", using fallback=${fallback}`);
  }
  return envFallback(key, fallback);
}

export async function getAllConfig(): Promise<Record<string, string>> {
  await load();
  return Object.fromEntries(cache);
}

export async function updateConfig(
  key: ConfigKey,
  value: string,
  changedBy = 'admin',
): Promise<void> {
  const old = cache.get(key);
  await db('config')
    .insert({ key, value })
    .onConflict('key')
    .merge({ value });
  cache.set(key, value);

  if (key.startsWith('fee_rate')) {
    try {
      await db('fee_audit_log').insert({
        config_key: key,
        old_value: old ?? null,
        new_value: value,
        changed_by: changedBy,
      });
    } catch (err) {
      console.warn(`[ConfigService] fee_audit_log insert skipped for key="${key}":`, err);
    }
  }
}

export function invalidateCache(): void {
  cache.clear();
  cacheLoaded = false;
}

export type TokenSide = 'buy' | 'sell';
export type TokenKind = 'spread' | 'fee_rate' | 'min_fee' | 'min_order_amount' | 'max_order_amount';

const DEFAULT_TOKEN_CONFIG: TokenSideConfig = {
  spread: 50,
  fee_rate: 0.008,
  min_fee: 5000,
  min_order_amount: 1,
  max_order_amount: 100,
};

const SUPPORTED_TOKENS = ['AVAX', 'USDT'];

export async function getTokenSideConfigFromDb(token: string, side: TokenSide): Promise<TokenSideConfig | null> {
  const key = `${token.toUpperCase()}_${side}`;
  const raw = await getConfig(key);
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenSideConfig> & { source?: unknown };
    const source = typeof parsed.source === 'string' ? parsed.source.trim().toLowerCase() : undefined;
    return {
      spread: Number(parsed.spread) ?? DEFAULT_TOKEN_CONFIG.spread,
      fee_rate: Number(parsed.fee_rate) ?? DEFAULT_TOKEN_CONFIG.fee_rate,
      min_fee: Number(parsed.min_fee) ?? DEFAULT_TOKEN_CONFIG.min_fee,
      min_order_amount: Number(parsed.min_order_amount) ?? DEFAULT_TOKEN_CONFIG.min_order_amount,
      max_order_amount: Number(parsed.max_order_amount) ?? DEFAULT_TOKEN_CONFIG.max_order_amount,
      source,
    };
  } catch {
    console.warn(`[ConfigService] Failed to parse token config for key="${key}" raw="${raw}"`);
    return null;
  }
}

export async function getAllTokenConfigs(): Promise<Record<string, Record<string, TokenSideConfig>>> {
  const results: Record<string, Record<string, TokenSideConfig>> = {};
  await load();
  for (const token of SUPPORTED_TOKENS) {
    results[token] = {};
    for (const side of ['buy', 'sell'] as TokenSide[]) {
      const cfg = await getTokenSideConfigFromDb(token, side);
      results[token][side] = cfg ?? { ...DEFAULT_TOKEN_CONFIG };
    }
  }
  return results;
}

export async function upsertTokenConfig(
  token: string,
  side: TokenSide,
  partial: Partial<TokenSideConfig>,
  changedBy = 'admin',
): Promise<void> {
  const existing = await getTokenSideConfigFromDb(token, side);
  const merged: TokenSideConfig = existing ?? { ...DEFAULT_TOKEN_CONFIG };
  Object.assign(merged, partial);

  const key = `${token.toUpperCase()}_${side}`;
  const value = JSON.stringify(merged);

  const old = cache.get(key);
  await db('config')
    .insert({ key, value })
    .onConflict('key')
    .merge({ value });
  cache.set(key, value);

  try {
    await db('fee_audit_log').insert({
      config_key: key,
      old_value: old ?? null,
      new_value: value,
      changed_by: changedBy,
    });
  } catch (err) {
    console.warn(`[ConfigService] fee_audit_log insert skipped for key="${key}":`, err);
  }
}

async function getGlobalFallback(side: TokenSide, kind: TokenKind): Promise<number> {
  const globalDefaults: Record<TokenKind, Record<TokenSide, number>> = {
    spread: { buy: 50, sell: 50 },
    fee_rate: { buy: 0.008, sell: 0.008 },
    min_fee: { buy: 5000, sell: 5000 },
    min_order_amount: { buy: 1, sell: 1 },
    max_order_amount: { buy: 100, sell: 100 },
  };
  return globalDefaults[kind]?.[side] ?? 50;
}

export async function getTokenConfig(
  token: string,
  side: TokenSide,
  kind: TokenKind,
): Promise<number> {
  const tokenConfig = await getTokenSideConfigFromDb(token, side);
  if (tokenConfig !== null) {
    return tokenConfig[kind];
  }
  return getGlobalFallback(side, kind);
}