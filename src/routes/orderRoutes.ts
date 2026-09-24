import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  type DepositRequest,
  type WithdrawalRequest,
} from '../services/orderService';
import { handleDeposit, handleWithdrawal, handleListOrders, handleGetOrder, handleCancel } from '../controllers/orderController';
import { partnerAuth } from '../middlewares/partnerAuth';

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: DepositRequest }>('/deposit', {
    preHandler: partnerAuth,
    schema: {
      security: [{ PartnerAppKey: [] }],
      tags: ['Orders'],
      summary: 'Create a deposit order (buy AVAX/USDT)',
      description: 'Creates a buy order. Returns SePay checkout session with bank transfer details. Order expires after 5 minutes (configurable via ORDER_EXPIRY_MINUTES). On creation, a callback is fired with order_state=CREATED. User must transfer VND to SePay with payment code as transfer content. Payout settles on Avalanche C-Chain to the recipient 0x address.',
      body: {
        type: 'object',
        required: ['amount', 'chain_id', 'asset_code', 'recipient', 'callback'],
        properties: {
          amount: { type: 'string', description: 'Amount of crypto to buy (e.g. "100"). Must be positive number string.' },
          chain_id: { type: 'integer', description: 'Avalanche C-Chain id (43113 Fuji, 43114 Mainnet)' },
          token_address: { type: 'string', description: 'C-Chain ERC-20 contract. Use the native USDT contract, or empty string "" for native AVAX.' },
          asset_code: { type: 'string', description: 'Asset code: "AVAX" (native) or "USDT" (ERC-20)' },
          recipient: { type: 'string', description: "User's Avalanche C-Chain (EVM) 0x wallet address to receive the payout." },
          callback: { type: 'string', description: 'HTTPS webhook URL. Called on every order state change with HMAC signature.' },
          user_id: { type: 'string', description: 'Optional client-side user ID for tracking.' },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Order created. Use `body.bankInfo` to show bank transfer details.',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        400: {
          type: 'object',
          description: 'Validation or business logic error.',
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
  }, handleDeposit);

  app.post<{ Body: WithdrawalRequest }>('/withdrawal', {
    preHandler: partnerAuth,
    schema: {
      security: [{ PartnerAppKey: [] }],
      tags: ['Orders'],
      summary: 'Create a withdrawal order (sell AVAX/USDT)',
      description: 'Creates a sell order. The client sends crypto to the per-order C-Chain custodial 0x address returned in `pay_data.address`; funds are swept to the Master Wallet. Order expires after 5 minutes.',
      body: {
        type: 'object',
        required: ['amount', 'chain_id', 'asset_code', 'callback', 'payment_info'],
        properties: {
          amount: { type: 'string', description: 'Amount of crypto to sell. Must be positive number string.' },
          chain_id: { type: 'integer', description: 'Avalanche C-Chain id (43113 Fuji, 43114 Mainnet)' },
          token_address: { type: 'string', description: 'Token contract address. Required for USDT (ERC-20). Use empty string "" for native AVAX.' },
          asset_code: { type: 'string', description: 'Asset code: "AVAX" (native) or "USDT" (ERC-20)' },
          callback: { type: 'string', description: 'HTTPS webhook URL. Called on every order state change with HMAC signature.' },
          user_id: { type: 'string', description: 'Optional client-side user ID.' },
          payment_info: {
            type: 'object',
            required: ['bank_id', 'full_name', 'account_type', 'account_number'],
            description: 'Bank account for VND payout.',
            properties: {
              bank_id: { type: 'string', description: 'Bank BIN (e.g. "970422" for MBBank)' },
              full_name: { type: 'string', description: 'Account holder name (no accents, no special chars)' },
              account_type: { type: 'integer', description: 'Account type: 0=khong thuong (checking), 1=atm, 2=tin dung' },
              account_number: { type: 'string', description: 'Bank account number' },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Order created. Use `pay_data.address` (C-Chain 0x deposit address) for the crypto transfer.',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        400: {
          type: 'object',
          description: 'Validation or business logic error.',
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
  }, handleWithdrawal);

  app.get<{ Querystring: { limit?: string; offset?: string; direction?: string; user_id?: string } }>('/', {
    schema: {
      tags: ['Orders'],
      summary: 'List orders',
      description: 'Returns paginated orders, sorted by updated_at descending. No authentication required. Pass user_id to scope results to a single registered user (used by web-be).',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'string', description: 'Max results (default 20, max 100)' },
          offset: { type: 'string', description: 'Offset for pagination (default 0)' },
          direction: { type: 'string', enum: ['buy', 'sell'], description: 'Filter by direction: buy (deposit) or sell (withdrawal)' },
          user_id: { type: 'string', description: 'Scope results to a single user ID (web-be passes the authenticated user).' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  payment_code: { type: 'string' },
                  transaction_hash: { type: ['string', 'null'] },
                  order_state: { type: 'number' },
                  direction: { type: 'string' },
                  usdt_amount: { type: 'number' },
                  asset_code: { type: 'string' },
                  net_vnd: { type: 'number' },
                  fee_vnd: { type: 'number' },
                  rate: { type: 'number' },
                  created_at: { type: 'string' },
                  updated_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, handleListOrders);

  app.get<{ Params: { id: string }; Querystring: { user_id?: string } }>('/:id', {
    preHandler: partnerAuth,
    schema: {
      security: [{ PartnerAppKey: [] }],
      tags: ['Orders'],
      summary: 'Get order status',
      description: 'Fetches current order state and details. Accepts numeric order ID or payment code (e.g. DHA1B2C3D4). Pass user_id to enforce ownership (web-be passes the authenticated user); a mismatched order returns 404.',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Order ID (numeric) or payment code (e.g. DHA1B2C3D4)' },
        },
      },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: { type: 'string', description: 'Enforce that the order belongs to this user ID (web-be passes the authenticated user).' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        404: {
          type: 'object',
          description: 'Order not found.',
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
  }, handleGetOrder);

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/:id/cancel', {
    preHandler: partnerAuth,
    schema: {
      security: [{ PartnerAppKey: [] }],
      tags: ['Orders'],
      summary: 'Cancel an order',
      description: 'Cancels an order. Only orders in CREATED(1) state, or PROCESSING(2) without irreversible steps (no sepay_transaction_id), can be cancelled.',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Order ID (numeric) or payment code (e.g. DHA1B2C3D4)' },
        },
      },
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional cancellation reason (logged, not shown to user).' },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Order cancelled successfully.',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        404: {
          type: 'object',
          description: 'Order not found.',
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
        409: {
          type: 'object',
          description: 'Order cannot be cancelled (e.g. already processing, crypto received).',
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
  }, handleCancel);
}
