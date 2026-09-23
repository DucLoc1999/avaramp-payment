import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getLatestPrice, getHistory, type Exchange } from '../services/snapshotLandingPageDb';
import { getRate, getMinFee } from '../services/priceService';

async function handleAllRates(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const exchanges: Exchange[] = ['binance', 'okx', 'bybit'];
  const assets = ['USDT', 'AVAX'] as const;

  const p2p: Record<string, Record<string, { bestBuyPrice: number | null; bestSellPrice: number | null }>> = {};
  for (const ex of exchanges) {
    p2p[ex] = {};
    for (const asset of assets) {
      p2p[ex][asset.toLowerCase()] = {
        bestBuyPrice: getLatestPrice(ex, 'buy', asset),
        bestSellPrice: getLatestPrice(ex, 'sell', asset),
      };
    }
  }

  const [usdtRate, avaxRate] = await Promise.all([getRate('USDT'), getRate('AVAX')]);
  const [usdtMinFee, avaxMinFee] = await Promise.all([getMinFee('USDT'), getMinFee('AVAX')]);

  const our = {
    usdt: {
      buy: usdtRate.buy_price,
      sell: usdtRate.sell_price,
      fee_rate_buy: usdtRate.fee_rate_buy,
      fee_rate_sell: usdtRate.fee_rate_sell,
      min_fee_vnd: usdtMinFee,
      created_at: usdtRate.updated_at,
    },
    avax: {
      buy: avaxRate.buy_price,
      sell: avaxRate.sell_price,
      fee_rate_buy: avaxRate.fee_rate_buy,
      fee_rate_sell: avaxRate.fee_rate_sell,
      min_fee_vnd: avaxMinFee,
      created_at: avaxRate.updated_at,
    },
  };

  return reply.send({ ...p2p, our });
}

async function handleAllHistory(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { days } = request.query as { days?: number };
  const d = Math.min(30, Math.max(1, Number(days) || 7));
  const exchanges: Exchange[] = ['binance', 'okx', 'bybit', 'our'];
  const result: Record<string, ReturnType<typeof getHistory>> = {};
  for (const ex of exchanges) {
    result[ex] = getHistory(ex, d);
  }
  return reply.send(result);
}

export async function landingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/p2p-rates', {
    schema: {
      tags: ['Landing Page'],
      summary: 'Get all P2P rates (Binance, OKX, Bybit, our service)',
      description: 'Returns best buy and sell prices from Binance, OKX, Bybit P2P markets plus our service rates for USDT and AVAX. No authentication required.',
      response: {
        200: {
          type: 'object',
          properties: {
            binance: {
              type: 'object',
              properties: {
                usdt: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true, description: 'Best buy price (null if no offers)' },
                    bestSellPrice: { type: 'number', nullable: true, description: 'Best sell price (null if no offers)' },
                  },
                },
                avax: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true },
                    bestSellPrice: { type: 'number', nullable: true },
                  },
                },
              },
            },
            okx: {
              type: 'object',
              properties: {
                usdt: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true },
                    bestSellPrice: { type: 'number', nullable: true },
                  },
                },
                avax: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true },
                    bestSellPrice: { type: 'number', nullable: true },
                  },
                },
              },
            },
            bybit: {
              type: 'object',
              properties: {
                usdt: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true },
                    bestSellPrice: { type: 'number', nullable: true },
                  },
                },
                avax: {
                  type: 'object',
                  properties: {
                    bestBuyPrice: { type: 'number', nullable: true },
                    bestSellPrice: { type: 'number', nullable: true },
                  },
                },
              },
            },
            our: {
              type: 'object',
              properties: {
                usdt: {
                  type: 'object',
                  properties: {
                    buy: { type: 'number' },
                    sell: { type: 'number' },
                    fee_rate_buy: { type: 'number' },
                    fee_rate_sell: { type: 'number' },
                    min_fee_vnd: { type: 'number' },
                    created_at: { type: 'string' },
                  },
                },
                avax: {
                  type: 'object',
                  properties: {
                    buy: { type: 'number' },
                    sell: { type: 'number' },
                    fee_rate_buy: { type: 'number' },
                    fee_rate_sell: { type: 'number' },
                    min_fee_vnd: { type: 'number' },
                    created_at: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, handleAllRates);

  app.get('/p2p-history', {
    schema: {
      tags: ['Landing Page'],
      summary: 'Get P2P price history',
      description: 'Returns historical best buy/sell prices for Binance, OKX, Bybit, and our service. Defaults to 7 days, max 30 days.',
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 30, description: 'History window in days (default 7, max 30)' },
        },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                created_at: { type: 'number', description: 'Unix timestamp' },
                buy: { type: 'number', nullable: true },
                sell: { type: 'number', nullable: true },
              },
            },
          },
        },
      },
    },
  }, handleAllHistory);
}
