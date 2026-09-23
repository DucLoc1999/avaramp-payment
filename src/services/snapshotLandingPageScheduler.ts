import * as crypto from 'crypto';
import { insertSnapshot, type Exchange } from './snapshotLandingPageDb';
import { getRate } from './priceService';
import { fetchBinanceP2POffers } from './priceSources/binanceSource';
import { logger } from '../config/logger';

const INTERVAL_MS = 60_000;

interface BybitApiResponse {
  ret_code: number;
  result?: { items?: Array<{ price: string }> };
}

interface OkxIndexResponse {
  data?: Array<{ idxPx?: string }>;
}

interface UsdRateResponse {
  rates: { VND: number };
}

const ASSETS = ['USDT', 'AVAX'] as const;

async function fetchBinancePrices(asset: string): Promise<{ buy: number | null; sell: number | null }> {
  const opts = { asset, rows: 20, merchantCheck: true, publisherType: 'merchant', transAmount: '150000000' };
  try {
    const [buyPrices, sellPrices] = await Promise.all([
      fetchBinanceP2POffers({ ...opts, tradeType: 'BUY' }),
      fetchBinanceP2POffers({ ...opts, tradeType: 'SELL' }),
    ]);

    const buy = buyPrices.length ? Math.min(...buyPrices) : null;
    const sell = sellPrices.length ? Math.max(...sellPrices) : null;
    return { buy, sell };
  } catch (err) {
    // Preserve nulls when Binance returns no data or request fails
    return { buy: null, sell: null };
  }
}
async function fetchOkxPrices(asset: string): Promise<{ buy: number | null; sell: number | null }> {
  const HANOI_PREMIUM = 412;

  function getSignature(secretKey: string, timestamp: string, method: string, path: string): string {
    return crypto.createHmac('sha256', secretKey).update(timestamp + method + path).digest('base64');
  }

  const timestamp = new Date().toISOString();
  const path = `/api/v5/market/index-tickers?instId=${asset}-USD`;
  const response = await fetch(`https://www.okx.com${path}`, {
    headers: {
      'OK-ACCESS-KEY': process.env.OKX_API_KEY!,
      'OK-ACCESS-SIGN': getSignature(process.env.OKX_SECRET_KEY!, timestamp, 'GET', path),
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': process.env.OKX_PASSPHRASE!,
    },
  });
  const json = (await response.json()) as OkxIndexResponse;
  const assetPeg = parseFloat(json.data?.[0]?.idxPx || '1.0000');

  const rateRes = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
  const rateJson = (await rateRes.json()) as UsdRateResponse;
  const bankRate = rateJson.rates.VND;

  const marketMid = bankRate * assetPeg + HANOI_PREMIUM;
  const buy = Math.round(marketMid * 1.0016);
  const sell = Math.round(marketMid * 0.9984);
  return { buy, sell };
}

async function fetchBybitPrices(asset: string): Promise<{ buy: number | null; sell: number | null }> {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json',
  };

  async function fetchSide(isBuying: boolean): Promise<number | null> {
    const response = await fetch('https://api2.bybit.com/fiat/otc/item/online', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tokenId: asset,
        currencyId: 'VND',
        side: isBuying ? '1' : '0',
        size: '10',
        page: '1',
        amount: '',
        authMaker: true,
        canTrade: false,
      }),
    });
    const json = (await response.json()) as BybitApiResponse;
    if (json.ret_code !== 0 || !json.result?.items?.length) return null;
    return Number(json.result.items[0].price);
  }

  const [buy, sell] = await Promise.all([fetchSide(true), fetchSide(false)]);
  return { buy, sell };
}

async function fetchOurPrices(asset: string): Promise<{ buy: number; sell: number }> {
  const rate = await getRate(asset);
  return { buy: rate.buy_price, sell: rate.sell_price };
}

function recordPrices(exchange: Exchange, asset: string, prices: { buy: number | null; sell: number | null }): void {
  if (prices.buy !== null) {
    insertSnapshot({ exchange, trade_type: 'buy', asset, fiat: 'VND', best_price: prices.buy });
  }
  if (prices.sell !== null) {
    insertSnapshot({ exchange, trade_type: 'sell', asset, fiat: 'VND', best_price: prices.sell });
  }
}

async function tick(): Promise<void> {
  const results = await Promise.allSettled(
    ASSETS.flatMap((asset) => [
      fetchBinancePrices(asset).then((p) => recordPrices('binance', asset, p)),
      fetchOkxPrices(asset).then((p) => recordPrices('okx', asset, p)),
      fetchBybitPrices(asset).then((p) => recordPrices('bybit', asset, p)),
      fetchOurPrices(asset).then((p) => recordPrices('our', asset, p)),
    ])
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn({ err: r.reason }, 'Snapshot fetch failed for one exchange');
    }
  }
}

export function startSnapshotScheduler(): NodeJS.Timeout {
  logger.info('Snapshot scheduler started (interval: 60s)');
  tick();
  return setInterval(tick, INTERVAL_MS);
}
