import { getPrices } from './priceSources';
import { getTokenConfig } from './configService';

export interface RateResult {
  buy_price: number;
  sell_price: number;
  binance_mid: number;
  spread_buy: number;
  spread_sell: number;
  fee_rate_buy: number;
  fee_rate_sell: number;
  updated_at: string;
  cached: boolean;
}

export interface QuoteResult {
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
}

const DEFAULT_ASSET = 'USDT';

export async function getRate(asset: string = DEFAULT_ASSET): Promise<RateResult> {
  const [prices, spreadBuy, spreadSell, feeRateBuy, feeRateSell] = await Promise.all([
    getPrices(asset),
    getTokenConfig(asset, 'buy', 'spread'),
    getTokenConfig(asset, 'sell', 'spread'),
    getTokenConfig(asset, 'buy', 'fee_rate'),
    getTokenConfig(asset, 'sell', 'fee_rate'),
  ]);

  const binance_mid = Math.round((prices.buy + prices.sell) / 2);

  return {
    buy_price: Math.round(prices.buy + spreadBuy),
    sell_price: Math.round(prices.sell - spreadSell),
    binance_mid,
    spread_buy: spreadBuy,
    spread_sell: spreadSell,
    fee_rate_buy: feeRateBuy,
    fee_rate_sell: feeRateSell,
    updated_at: new Date().toISOString(),
    cached: prices.cached,
  };
}

export const DEFAULT_MIN_FEE_VND = 5000;

export async function getMinFee(asset: string = DEFAULT_ASSET): Promise<number> {
  return getTokenConfig(asset, 'buy', 'min_fee');
}

export async function getQuote(direction: 'buy' | 'sell', usdt_amount: number, asset: string = DEFAULT_ASSET): Promise<QuoteResult> {
  const rate = await getRate(asset);
  const [minFee] = await Promise.all([getMinFee(asset)]);

  const price = direction === 'buy' ? rate.buy_price : rate.sell_price;
  const original_rate = direction === 'buy' ? rate.buy_price - rate.spread_buy : rate.sell_price + rate.spread_sell;
  const spread = direction === 'buy' ? rate.spread_buy : rate.spread_sell;
  const fee_rate = direction === 'buy' ? rate.fee_rate_buy : rate.fee_rate_sell;
  const gross_vnd = Math.round(usdt_amount * price);
  const calculatedFee = Math.round(gross_vnd * fee_rate);
  const fee_vnd = Math.max(calculatedFee, minFee);
  const net_vnd = direction === 'buy' ? gross_vnd + fee_vnd : gross_vnd - fee_vnd;

  const assetCode = asset.toUpperCase();
  const note =
    direction === 'buy'
      ? `Bạn cần chuyển ${net_vnd.toLocaleString('vi-VN')} VND để nhận ${usdt_amount} ${assetCode}`
      : `Bạn nhận được ${net_vnd.toLocaleString('vi-VN')} VND khi bán ${usdt_amount} ${assetCode}`;

  return { direction, usdt_amount, rate: price, original_rate, spread, gross_vnd, fee_rate, fee_vnd, net_vnd, note };
}