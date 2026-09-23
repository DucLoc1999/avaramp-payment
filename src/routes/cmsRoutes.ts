import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleCmsLogin, handleCreateAdmin, handleGetConfig, handlePatchCmsConfig, handleGetRates, handleGetAuditLog, handleChangePassword, handleGetBuyOrders, handleGetSellOrders } from '../controllers/cmsController';
import { handleCreatePartner, handleGetPartner, handleListPartners, handleUpdatePartner } from '../controllers/partnerController';
import { adminAuth } from '../middlewares/adminAuth';

const partnerDataSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    key: { type: 'string' },
    fee_buy: { type: 'number' },
    fee_sell: { type: 'number' },
    active: { type: 'boolean' },
    creator: { type: ['number', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: ['string', 'null'] },
  },
};

const tokenSideConfigSchema = {
  type: 'object',
  properties: {
    spread: { type: 'number', description: 'Spread in VND' },
    fee_rate: { type: 'number', description: 'Fee rate (e.g. 0.008 = 0.8%)' },
    min_fee: { type: 'number', description: 'Minimum fee in VND' },
    min_order_amount: { type: 'number', description: 'Minimum order amount in crypto units' },
    max_order_amount: { type: 'number', description: 'Maximum order amount (null = unlimited)' },
    source: { type: 'string', description: 'Price source: binance, okx, bybit, or our' },
  },
};

const tokenConfigSchema = {
  type: 'object',
  properties: {
    buy: tokenSideConfigSchema,
    sell: tokenSideConfigSchema,
  },
};

const configResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      properties: {
        available_price_sources: { type: 'array', items: { type: 'string' } },
        configs: {
          type: 'object',
          properties: {
            usdt: tokenConfigSchema,
            avax: tokenConfigSchema,
          },
        },
      },
    },
  },
};

const tokenSidePatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    spread: { type: 'number', description: 'Spread in VND' },
    fee_rate: { type: 'number', description: 'Fee rate' },
    min_fee: { type: 'number', description: 'Minimum fee in VND' },
    min_order_amount: { type: 'number', description: 'Minimum order amount' },
    max_order_amount: { type: 'number', description: 'Maximum order amount' },
    source: { type: 'string', description: 'Price source' },
  },
};

const tokenPatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    buy: tokenSidePatchSchema,
    sell: tokenSidePatchSchema,
  },
};

export async function cmsRoutes(app: FastifyInstance): Promise<void> {
  // ── Auth ─────────────────────────────────────────────────────────────────

  app.post('/login', {
    schema: {
      tags: ['CMS'],
      summary: 'CMS admin login',
      description: 'Authenticates a CMS admin and returns a JWT. Token expires in 12 hours (configurable via ADMIN_JWT_TTL_SEC).',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', description: 'Admin email address' },
          password: { type: 'string', description: 'Admin password' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                access_token: { type: 'string' },
                token_type: { type: 'string' },
                expires_in: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          description: 'Invalid credentials.',
          properties: { success: { type: 'boolean' }, error: { type: 'string' } },
        },
      },
    },
  }, handleCmsLogin as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  // ── Admin ─────────────────────────────────────────────────────────────────

  app.post('/admins', {
    schema: {
      tags: ['CMS'],
      summary: 'Create a new admin account',
      description: 'Creates a new admin. Requires CMS_CREATE_ADMIN_KEY env var to be set. Password must be at least 8 characters.',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'email', 'password'],
        properties: {
          key: { type: 'string', description: 'CMS create-admin key (from CMS_CREATE_ADMIN_KEY env)' },
          email: { type: 'string', format: 'email', description: 'New admin email (must be unique)' },
          password: { type: 'string', minLength: 8, description: 'Password (min 8 characters)' },
        },
      },
      response: {
        201: {
          type: 'object',
          description: 'Admin created.',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                email: { type: 'string' },
              },
            },
          },
        },
        400: {
          type: 'object',
          description: 'Validation error (password too short, email taken, invalid key).',
          properties: {
            success: { type: 'boolean' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retriable: { type: 'boolean' },
                trace_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, handleCreateAdmin as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.get('/admin/audit', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Get fee configuration audit log',
      description: 'Returns last 50 fee config changes with old/new values and admin email.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          description: 'Array of audit log entries.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              action: { type: 'string' },
              details: { type: 'string' },
              createdAt: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, handleGetAuditLog as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.patch('/admin/password', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Change own admin password',
      description: 'Changes password for the authenticated admin. Requires correct current password.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', description: 'Current password' },
          newPassword: { type: 'string', minLength: 8, description: 'New password (min 8 characters)' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        400: { type: 'object', description: 'New password too short.', properties: { success: { type: 'boolean' }, error: { type: 'string' } } },
        401: { type: 'object', description: 'Current password incorrect.', properties: { success: { type: 'boolean' }, error: { type: 'string' } } },
      },
    },
  }, handleChangePassword as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  // ── Partner ───────────────────────────────────────────────────────────────

  app.post('/partner', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Create a new partner account',
      description: 'Creates a partner with custom fee overrides (fee_buy/fee_sell). Each partner gets a unique API key.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'fee_buy', 'fee_sell'],
        properties: {
          name: { type: 'string', description: 'Partner display name' },
          fee_buy: { type: 'number', minimum: 0, description: 'Custom buy fee rate (e.g. 0.001 = 0.1%)' },
          fee_sell: { type: 'number', minimum: 0, description: 'Custom sell fee rate' },
          active: { type: 'boolean', description: 'Whether partner API key is active (default true)' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: partnerDataSchema },
        },
      },
    },
  }, handleCreatePartner as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.get('/partner', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'List all partner accounts',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: partnerDataSchema },
          },
        },
      },
    },
  }, handleListPartners as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.get('/partner/:id', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Get partner account by ID',
      description: 'Returns full details for a single partner: id, name, API key, custom fee_buy/fee_sell overrides, and active status.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Partner UUID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: partnerDataSchema },
        },
      },
    },
  }, handleGetPartner as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.patch('/partner/:id', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Update partner account',
      description: 'Partially updates a partner. All fields are optional — only provided fields are changed.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Partner UUID' },
        },
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Partner display name' },
          fee_buy: { type: 'number', minimum: 0, description: 'Custom buy fee rate' },
          fee_sell: { type: 'number', minimum: 0, description: 'Custom sell fee rate' },
          active: { type: 'boolean', description: 'Enable or disable the partner API key' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: partnerDataSchema },
        },
        400: {
          type: 'object',
          description: 'Validation error or no fields provided.',
          properties: {
            success: { type: 'boolean' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retriable: { type: 'boolean' },
                trace_id: { type: 'string' },
              },
            },
          },
        },
        404: {
          type: 'object',
          description: 'Partner not found.',
          properties: {
            success: { type: 'boolean' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retriable: { type: 'boolean' },
                trace_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, handleUpdatePartner as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  // ── Config ────────────────────────────────────────────────────────────────

  app.get('/config', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Get per-token fee and spread configuration',
      description: 'Returns current per-token (USDT, AVAX) config for spreads, fee rates, min/max order amounts, and price sources. Creates default values if not yet set.',
      security: [{ BearerAuth: [] }],
      response: { 200: configResponseSchema },
    },
  }, handleGetConfig as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.patch('/config', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Update per-token fee and spread configuration',
      description: 'Updates per-token config. All fields optional — only provided fields are changed. Changes are logged to fee_audit_log.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          usdt: tokenPatchSchema,
          avax: tokenPatchSchema,
        },
      },
      response: {
        200: configResponseSchema,
        400: {
          type: 'object',
          description: 'No config fields provided.',
          properties: {
            success: { type: 'boolean' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retriable: { type: 'boolean' },
                trace_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, handlePatchCmsConfig as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  // ── Orders ────────────────────────────────────────────────────────────────

  app.get('/orders/buy', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Get all buy (deposit) orders',
      description: 'Returns all buy orders sorted by updated_at descending. Shows payment code, amount, rate, fees, recipient, transaction hash, and order state.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, handleGetBuyOrders as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  app.get('/orders/sell', {
    preHandler: adminAuth,
    schema: {
      tags: ['CMS'],
      summary: 'Get all sell (withdrawal) orders',
      description: 'Returns all sell orders sorted by updated_at descending. Shows payment code, amount, rate, fees, payment_info (bank details), transaction hash, and order state.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, handleGetSellOrders as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);

  // ── Rates ─────────────────────────────────────────────────────────────────

  app.get('/rates', {
    schema: {
      tags: ['CMS'],
      summary: 'Get current buy and sell rates for USDT and AVAX (public)',
      description: 'No authentication required. Returns our current buy/sell rates for USDT and AVAX.',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                usdt: { type: 'object', properties: { buy: { type: 'number' }, sell: { type: 'number' } } },
                avax:  { type: 'object', properties: { buy: { type: 'number' }, sell: { type: 'number' } } },
              },
            },
          },
        },
      },
    },
  }, handleGetRates as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);
}
