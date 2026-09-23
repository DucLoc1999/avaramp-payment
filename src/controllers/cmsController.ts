import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAdminCredentials, createAdmin, findAdminByEmail, changeAdminPassword } from '../services/adminService';
import { getAllTokenConfigs, upsertTokenConfig, getConfig, updateConfig } from '../services/configService';
import { AVAILABLE_PRICE_SOURCES } from '../services/priceSources';
import { getRate } from '../services/priceService';
import { signJwt } from '../utils/jwt';
import { createErrorReply } from '../middlewares/errorHandler';
import db from '../db';

const ACCESS_TOKEN_TTL_SEC = Number(process.env.ADMIN_JWT_TTL_SEC ?? 60 * 60 * 12);

export async function handleCmsLogin(
  req: FastifyRequest<{ Body: { email: string; password: string } }>,
  reply: FastifyReply,
) {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    reply.code(503).send({ success: false, error: 'Admin auth not configured' });
    return;
  }

  const { email, password } = req.body ?? ({} as any);
  if (!email || !password) {
    reply.code(400).send({ success: false, error: 'Missing email or password' });
    return;
  }

  const admin = await verifyAdminCredentials(email, password);
  if (!admin) {
    reply.code(401).send({ success: false, error: 'Invalid credentials' });
    return;
  }

  const access_token = signJwt({ sub: admin.id, email: admin.email }, secret, ACCESS_TOKEN_TTL_SEC);
  reply.send({
    success: true,
    data: {
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
    },
  });
}

export async function handleCreateAdmin(
  req: FastifyRequest<{ Body: { key: string; email: string; password: string } }>,
  reply: FastifyReply,
) {
  const createAdminKey = process.env.CMS_CREATE_ADMIN_KEY;
  if (!createAdminKey) {
    reply.code(503).send({ success: false, error: 'Create admin not configured' });
    return;
  }

  const { key, email, password } = req.body ?? ({} as any);

  if (!key || key !== createAdminKey) {
    reply.code(401).send({ success: false, error: 'Invalid key' });
    return;
  }

  if (!email || typeof email !== 'string') {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'Email is required', req.id);
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'Password must be at least 8 characters', req.id);
  }

  const existing = await findAdminByEmail(email);
  if (existing) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'Email already in use', req.id);
  }

  const id = await createAdmin(email, password);
  return reply.code(201).send({ success: true, data: { id, email } });
}

const TOKENS = ['usdt', 'avax'] as const;
type Token = typeof TOKENS[number];

type SidePatch = { spread?: number; fee_rate?: number; min_fee?: number; min_order_amount?: number; max_order_amount?: number; source?: string };
type PatchBody = Partial<Record<Token, { buy?: SidePatch; sell?: SidePatch }>>;

const AVAILABLE_PRICE_SOURCES_KEY = 'available_price_sources';

async function getAvailablePriceSources(): Promise<string[]> {
  const raw = await getConfig(AVAILABLE_PRICE_SOURCES_KEY);
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through to save defaults
    }
  }
  await updateConfig(AVAILABLE_PRICE_SOURCES_KEY, JSON.stringify(AVAILABLE_PRICE_SOURCES), 'system');
  return AVAILABLE_PRICE_SOURCES;
}

async function buildConfigData(): Promise<Record<string, unknown>> {
  const [allConfigs, availableSources] = await Promise.all([getAllTokenConfigs(), getAvailablePriceSources()]);
  const tokenConfigs: Record<string, unknown> = {};
  for (const token of TOKENS) {
    const tokenCfg = allConfigs[token.toUpperCase()] ?? {};
    tokenConfigs[token] = {
      buy: { source: 'binance', ...tokenCfg.buy },
      sell: { source: 'binance', ...tokenCfg.sell },
    };
  }
  return {
    available_price_sources: availableSources,
    configs: tokenConfigs,
  };
}

export async function handleGetConfig(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const data = await buildConfigData();
  reply.send({ success: true, data });
}

export async function handlePatchCmsConfig(
  req: FastifyRequest<{ Body: PatchBody }>,
  reply: FastifyReply,
) {
  const body = req.body ?? {};
  const changedBy = req.admin?.email ?? 'cms';
  let hasUpdate = false;

  for (const token of TOKENS) {
    const tokenBody = body[token];
    if (!tokenBody) continue;
    for (const side of ['buy', 'sell'] as const) {
      const sideBody = tokenBody[side];
      if (!sideBody || Object.keys(sideBody).length === 0) continue;
      await upsertTokenConfig(token.toUpperCase(), side, sideBody, changedBy);
      hasUpdate = true;
    }
  }

  if (!hasUpdate) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'No config fields provided', req.id);
  }

  const data = await buildConfigData();
  reply.send({ success: true, data });
}

export async function handleChangePassword(
  req: FastifyRequest<{ Body: { currentPassword: string; newPassword: string } }>,
  reply: FastifyReply,
) {
  const { currentPassword, newPassword } = req.body ?? ({} as any);

  if (!currentPassword || !newPassword) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'currentPassword and newPassword are required', req.id);
  }
  if (newPassword.length < 8) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'New password must be at least 8 characters', req.id);
  }

  const email = req.admin!.email;
  const valid = await verifyAdminCredentials(email, currentPassword);
  if (!valid) {
    reply.code(401).send({ success: false, error: 'Current password is incorrect' });
    return;
  }

  await changeAdminPassword(email, newPassword);
  reply.send({ success: true });
}

export async function handleGetAuditLog(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const rows = await db('fee_audit_log')
    .orderBy('changed_at', 'desc')
    .limit(50);

  const entries = rows.map((r: any) => ({
    id: String(r.id),
    action: 'UPDATE_CONFIG',
    details: JSON.stringify({ key: r.config_key, old: r.old_value, new: r.new_value }),
    createdAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at),
    user: { name: r.changed_by ?? 'admin', email: r.changed_by ?? 'admin' },
  }));

  reply.send(entries);
}

export async function handleGetBuyOrders(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const rows = await db('orders')
    .where('direction', 'buy')
    .select(
      'payment_code',
      'usdt_amount',
      'rate',
      'net_vnd',
      'updated_at',
      'fee_vnd',
      'order_state',
      'transaction_hash',
      'asset_code',
      'recipient',
    )
    .orderBy('updated_at', 'desc');

  const data = rows.map((r: any) => ({
    updated_at: r.updated_at,
    payment_code: r.payment_code,
    transaction_hash: r.transaction_hash,
    recipient: r.recipient,
    usdt_amount: r.usdt_amount,
    asset_code: r.asset_code,
    rate: r.rate,
    net_vnd: r.net_vnd,
    fee_vnd: r.fee_vnd,
    order_state: r.order_state,
  }));

  reply.send({ success: true, data });
}

export async function handleGetSellOrders(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const rows = await db('orders')
    .where('direction', 'sell')
    .select(
      'payment_code',
      'usdt_amount',
      'rate',
      'net_vnd',
      'updated_at',
      'fee_vnd',
      'order_state',
      'transaction_hash',
      'asset_code',
      'payment_info',
    )
    .orderBy('updated_at', 'desc');

  const data = rows.map((r: any) => ({
    updated_at: r.updated_at,
    payment_code: r.payment_code,
    transaction_hash: r.transaction_hash,
    usdt_amount: r.usdt_amount,
    asset_code: r.asset_code,
    rate: r.rate,
    net_vnd: r.net_vnd,
    fee_vnd: r.fee_vnd,
    order_state: r.order_state,
    payment_info: r.payment_info,
  }));

  reply.send({ success: true, data });
}

export async function handleGetRates(
  _req: FastifyRequest,
  reply: FastifyReply,
) {
  const [usdt, avax] = await Promise.all([getRate('USDT'), getRate('AVAX')]);
  reply.send({
    success: true,
    data: {
      usdt: { buy: usdt.buy_price, sell: usdt.sell_price },
      avax: { buy: avax.buy_price, sell: avax.sell_price },
    },
  });
}
