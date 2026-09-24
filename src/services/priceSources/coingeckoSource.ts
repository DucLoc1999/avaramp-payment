import type { PriceSourceResult } from './index';

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

interface PriceCache {
  buy: number;
  sell: number;
  fetchedAt: number;
}

let priceCache = new Map<string, PriceCache>();

const DEFAULT_ASSET_MAP: Record<string, string> = {
  AVAX: 'avalanche-2',
  USDT: 'tether',
};

export interface CoinGeckoSourceConfig {
  api_key?: string;
  spread?: number;
  cache_ttl_ms?: number;
  asset_map?: Record<string, string>;
}

export async function coingeckoSource(asset: string, config: Record<string, unknown>): Promise<PriceSourceResult> {
  const cfg = config as CoinGeckoSourceConfig;
  const cacheTtl = cfg.cache_ttl_ms ?? 5_000;
  const spread = cfg.spread ?? 100;
  const assetMap = { ...DEFAULT_ASSET_MAP, ...(cfg.asset_map ?? {}) };
  const now = Date.now();
  const cacheKey = asset.toUpperCase();

  const cached = priceCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < cacheTtl) {
    return { ...cached, cached: true };
  }

  const coingeckoId = assetMap[cacheKey];
  if (!coingeckoId) {
    throw new Error(`No CoinGecko mapping for ${asset}`);
  }

  const apiKey = cfg.api_key ?? process.env.COINGECKO_API_KEY;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const url = `${COINGECKO_URL}?ids=${coingeckoId}&vs_currencies=vnd`;
  try {
    var res = await fetch(url);
    if (res.status == 429 && apiKey) {
      headers['x-cg-demo-api-key'] = apiKey;
      res = await fetch(url, { headers });
    }
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    const json = await res.json() as Record<string, { vnd: number }>;
    const price = json[coingeckoId]?.vnd;
    if (!price) throw new Error(`No price for ${coingeckoId} in CoinGecko response`);

    const buy = price + spread;
    const sell = price - spread;
    priceCache.set(cacheKey, { buy, sell, fetchedAt: now });
    return { buy, sell, cached: false };
  } catch {
    const fallback = priceCache.get(cacheKey);
    if (fallback) return { ...fallback, cached: true };
    throw new Error(`CoinGecko fetch failed for ${asset} and no cached data available`);
  }
}
