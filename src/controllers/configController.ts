import type { FastifyRequest, FastifyReply } from 'fastify';
import { getAllConfig, getAllTokenConfigs, updateConfig, upsertTokenConfig } from '../services/configService';

const GLOBAL_DEFAULTS = {
  spread_buy: 50,
  spread_sell: 50,
  fee_rate_buy: 0.008,
  fee_rate_sell: 0.008,
  usdt_min_fee: 5000,
  avax_min_fee: 5000,
};

async function buildConfigSnapshot() {
  const [flatConfig, tokenConfigs] = await Promise.all([getAllConfig(), getAllTokenConfigs()]);
  const usdtBuy = tokenConfigs['USDT']?.buy;
  const usdtSell = tokenConfigs['USDT']?.sell;
  const avaxBuy = tokenConfigs['AVAX']?.buy;
  const avaxSell = tokenConfigs['AVAX']?.sell;

  const num = (key: keyof typeof GLOBAL_DEFAULTS) => {
    const value = flatConfig[key];
    const parsed = value !== undefined ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : GLOBAL_DEFAULTS[key];
  };

  return {
    spread_buy: num('spread_buy'),
    spread_sell: num('spread_sell'),
    fee_rate_buy: num('fee_rate_buy'),
    fee_rate_sell: num('fee_rate_sell'),
    usdt_min_fee: num('usdt_min_fee'),
    avax_min_fee: num('avax_min_fee'),
    usdt_spread_buy: usdtBuy?.spread ?? 50,
    usdt_spread_sell: usdtSell?.spread ?? 50,
    usdt_fee_rate_buy: usdtBuy?.fee_rate ?? 0.008,
    usdt_fee_rate_sell: usdtSell?.fee_rate ?? 0.008,
    usdt_min_order_amount: usdtBuy?.min_order_amount ?? 1,
    usdt_source_buy: usdtBuy?.source,
    usdt_source_sell: usdtSell?.source,
    avax_spread_buy: avaxBuy?.spread ?? 50,
    avax_spread_sell: avaxSell?.spread ?? 50,
    avax_fee_rate_buy: avaxBuy?.fee_rate ?? 0.008,
    avax_fee_rate_sell: avaxSell?.fee_rate ?? 0.008,
    avax_min_order_amount: avaxBuy?.min_order_amount ?? 1,
    avax_source_buy: avaxBuy?.source,
    avax_source_sell: avaxSell?.source,
  };
}

export async function handleGetFees(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  reply.send({
    success: true,
    data: await buildConfigSnapshot(),
  });
}

export async function handleGetTokenFees(
  req: FastifyRequest<{ Params: { token: string } }>,
  reply: FastifyReply,
) {
  const token = req.params?.token?.trim().toUpperCase();
  const allTokenConfigs = await getAllTokenConfigs();
  const tokenConfig = token ? allTokenConfigs[token] : undefined;

  if (!token || !tokenConfig) {
    reply.code(404).send({ success: false, error: 'Token config not found' });
    return;
  }

  reply.send({
    success: true,
    data: {
      token,
      buy: tokenConfig.buy,
      sell: tokenConfig.sell,
    },
  });
}

interface TokenSidePatch {
  spread?: number;
  fee_rate?: number;
  min_fee?: number;
  min_order_amount?: number;
  source?: string;
}

interface PatchBody {
  spread_buy?: number;
  spread_sell?: number;
  fee_rate_buy?: number;
  fee_rate_sell?: number;
  usdt_min_fee?: number;
  avax_min_fee?: number;
  USDT_buy?: TokenSidePatch;
  USDT_sell?: TokenSidePatch;
  AVAX_buy?: TokenSidePatch;
  AVAX_sell?: TokenSidePatch;
}

export async function handlePatchConfig(
  req: FastifyRequest<{ Body: PatchBody }>,
  reply: FastifyReply,
) {
  const body = req.body ?? {};
  const changedBy = typeof req.admin?.email === 'string' ? req.admin.email : 'admin';

  const updates: Array<Promise<unknown>> = [];

  if (typeof body.spread_buy === 'number') {
    updates.push(updateConfig('spread_buy', String(body.spread_buy), changedBy));
  }
  if (typeof body.spread_sell === 'number') {
    updates.push(updateConfig('spread_sell', String(body.spread_sell), changedBy));
  }
  if (typeof body.fee_rate_buy === 'number') {
    updates.push(updateConfig('fee_rate_buy', String(body.fee_rate_buy), changedBy));
  }
  if (typeof body.fee_rate_sell === 'number') {
    updates.push(updateConfig('fee_rate_sell', String(body.fee_rate_sell), changedBy));
  }
  if (typeof body.usdt_min_fee === 'number') {
    updates.push(updateConfig('usdt_min_fee', String(body.usdt_min_fee), changedBy));
  }
  if (typeof body.avax_min_fee === 'number') {
    updates.push(updateConfig('avax_min_fee', String(body.avax_min_fee), changedBy));
  }

  const tokenSidePairs: Array<[token: string, side: 'buy' | 'sell', patch?: TokenSidePatch]> = [
    ['USDT', 'buy', body.USDT_buy],
    ['USDT', 'sell', body.USDT_sell],
    ['AVAX', 'buy', body.AVAX_buy],
    ['AVAX', 'sell', body.AVAX_sell],
  ];

  for (const [token, side, patch] of tokenSidePairs) {
    if (patch && Object.keys(patch).length > 0) {
      updates.push(upsertTokenConfig(token, side, patch, changedBy));
    }
  }

  if (updates.length === 0) {
    reply.code(400).send({ success: false, error: 'No config fields provided' });
    return;
  }

  await Promise.all(updates);

  reply.send({
    success: true,
    data: await buildConfigSnapshot(),
  });
}
