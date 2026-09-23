import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleGetFees, handleGetTokenFees, handlePatchConfig } from '../controllers/configController';
import { adminAuth } from '../middlewares/adminAuth';

const tokenSideConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    spread: { type: 'number', description: 'Spread in VND (added to buy, subtracted from sell)' },
    fee_rate: { type: 'number', description: 'Fee rate (e.g. 0.008 = 0.8%)' },
    min_fee: { type: 'number', description: 'Minimum fee in VND' },
    min_order_amount: { type: 'number', description: 'Minimum order amount in crypto units' },
    max_order_amount: { type: 'number', description: 'Maximum order amount in crypto units (null = unlimited)' },
    source: { type: 'string', description: 'Price source: "binance", "okx", "bybit", or "our"' },
  },
} as const;

const tokenFeeResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        buy: tokenSideConfigSchema,
        sell: tokenSideConfigSchema,
      },
    },
  },
} as const;

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fees', {
    schema: {
      tags: ['Config'],
      summary: 'Get current spreads and fee rates',
      description: 'Returns global defaults and per-token (USDT, AVAX) overrides for spreads, fee rates, min fees, and min/max order amounts.',
    },
  }, handleGetFees);

  app.get('/fee/:token', {
    schema: {
      tags: ['Config'],
      summary: 'Get fee config for a specific token',
      description: 'Returns full buy/sell config for USDT or AVAX including spread, fee_rate, min_fee, min_order_amount, max_order_amount, and source.',
      params: {
        type: 'object',
        additionalProperties: false,
        properties: {
          token: { type: 'string', description: 'Token code: "USDT" or "AVAX"' },
        },
      },
      response: {
        200: tokenFeeResponseSchema,
        404: {
          type: 'object',
          description: 'Token config not found.',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
  }, handleGetTokenFees);

  app.patch('/', {
    preHandler: adminAuth,
    schema: {
      tags: ['Config'],
      summary: 'Update spreads and fee rates',
      description: 'Updates global and/or per-token fee configuration. All fields optional — only provided fields are updated.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spread_buy: { type: 'number', description: 'Global spread for buy orders (VND)' },
          spread_sell: { type: 'number', description: 'Global spread for sell orders (VND)' },
          fee_rate_buy: { type: 'number', description: 'Global buy fee rate (e.g. 0.008 = 0.8%)' },
          fee_rate_sell: { type: 'number', description: 'Global sell fee rate (e.g. 0.008 = 0.8%)' },
          usdt_min_fee: { type: 'number', description: 'USDT minimum fee in VND' },
          avax_min_fee: { type: 'number', description: 'AVAX minimum fee in VND' },
          usdt_spread_buy: { type: 'number', description: 'USDT buy spread (overrides global spread_buy)' },
          usdt_spread_sell: { type: 'number', description: 'USDT sell spread (overrides global spread_sell)' },
          usdt_fee_rate_buy: { type: 'number', description: 'USDT buy fee rate' },
          usdt_fee_rate_sell: { type: 'number', description: 'USDT sell fee rate' },
          avax_spread_buy: { type: 'number', description: 'AVAX buy spread' },
          avax_spread_sell: { type: 'number', description: 'AVAX sell spread' },
          avax_fee_rate_buy: { type: 'number', description: 'AVAX buy fee rate' },
          avax_fee_rate_sell: { type: 'number', description: 'AVAX sell fee rate' },
          USDT_buy: tokenSideConfigSchema,
          USDT_sell: tokenSideConfigSchema,
          AVAX_buy: tokenSideConfigSchema,
          AVAX_sell: tokenSideConfigSchema,
        },
      },
    },
  }, handlePatchConfig as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);
}
