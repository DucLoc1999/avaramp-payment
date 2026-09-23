import type { PriceSourceResult } from './index';

const BINANCE_P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';

export interface BinanceP2POptions {
  asset: string;
  fiat?: string;
  tradeType: 'BUY' | 'SELL';
  rows?: number;
  merchantCheck?: boolean;
  publisherType?: string | null;
  transAmount?: string;
}

export interface BinanceSourceConfig {
  rows?: number;
  fiat?: string;
  merchantCheck?: boolean;
  publisherType?: string | null;
  transAmount?: string;
  cache_ttl_ms?: number;
}

export async function fetchBinanceP2POffers(opts: BinanceP2POptions): Promise<number[]> {
  const body: Record<string, unknown> = {
    asset: opts.asset,
    fiat: opts.fiat ?? 'VND',
    merchantCheck: opts.merchantCheck ?? false,
    page: 1,
    publisherType: opts.publisherType ?? null,
    rows: opts.rows ?? 5,
    tradeType: opts.tradeType,
  };
  if (opts.transAmount) body.transAmount = opts.transAmount;

  const res = await fetch(BINANCE_P2P_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Binance P2P returned ${res.status}`);

  const json = (await res.json()) as { data: Array<{ adv: { price: string } }> };
  const prices = json.data.map((d) => Number(d.adv.price));
  if (prices.length === 0) {
    throw new Error(`No ${opts.asset} offers on Binance P2P`);
  }
  return prices.sort((a, b) => a - b);
}

interface PriceCache {
  buy: number;
  sell: number;
  fetchedAt: number;
}

let priceCache = new Map<string, PriceCache>();

const FALLBACK_PRICES: Record<string, number> = {
  AVAX: 3_700_000,
  USDT: 26_500,
};

export async function binanceSource(asset: string, config: Record<string, unknown>): Promise<PriceSourceResult> {
  const cfg = config as BinanceSourceConfig;
  const cacheTtl = cfg.cache_ttl_ms ?? 5_000;
  const now = Date.now();
  const cacheKey = asset.toUpperCase();

  const cached = priceCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < cacheTtl) {
    return { ...cached, cached: true };
  }

  try {
    const opts: Omit<BinanceP2POptions, 'tradeType' | 'asset'> = {
      fiat: cfg.fiat,
      rows: cfg.rows,
      merchantCheck: cfg.merchantCheck,
      publisherType: cfg.publisherType,
      transAmount: cfg.transAmount,
    };
    const [buyPrices, sellPrices] = await Promise.all([
      fetchBinanceP2POffers({ ...opts, asset, tradeType: 'BUY' }),
      fetchBinanceP2POffers({ ...opts, asset, tradeType: 'SELL' }),
    ]);
    const buy = buyPrices[Math.floor(buyPrices.length / 2)];
    const sell = sellPrices[Math.floor(sellPrices.length / 2)];
    priceCache.set(cacheKey, { buy, sell, fetchedAt: now });
    return { buy, sell, cached: false };
  } catch {
    const fallback = priceCache.get(cacheKey);
    if (fallback) return { ...fallback, cached: true };
    const fallbackPrice = FALLBACK_PRICES[cacheKey] ?? 26500;
    return { buy: fallbackPrice + 100, sell: fallbackPrice - 100, cached: false };
  }
}
