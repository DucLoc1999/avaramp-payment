import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sepayAuth } from '../middlewares/sepayAuth';
import { cchainAuth } from '../middlewares/cchainAuth';
import type { SepayWebhookPayload } from '../models/types';
import { handleSepayWebhook } from '../controllers/webhookController';
import { handleCchainIncoming } from '../controllers/webhookController';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SepayWebhookPayload }>('/sepay', {
    preHandler: sepayAuth,
    schema: {
      tags: ['Webhooks'],
      summary: 'SePay bank transaction webhook — receives deposit notifications',
      security: [{ SepayWebhookKey: [] }],
      body: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Transaction ID on SePay' },
          gateway: { type: 'string', description: 'Bank brand name' },
          transactionDate: { type: 'string' },
          accountNumber: { type: 'string' },
          code: { type: 'string', nullable: true, description: 'Payment code detected by SePay' },
          content: { type: 'string', description: 'Transfer description' },
          transferType: { type: 'string', enum: ['in', 'out'] },
          transferAmount: { type: 'integer', description: 'Amount in VND' },
          accumulated: { type: 'integer' },
          subAccount: { type: 'string', nullable: true },
          referenceCode: { type: 'string' },
          description: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' } },
        },
      },
    },
  }, (req, reply) => handleSepayWebhook(req, reply, app));

  app.post<{ Body: CchainIncomingBody }>('/cchain-incoming', {
    preHandler: cchainAuth,
    schema: {
      tags: ['Webhooks'],
      summary: 'C-Chain incoming webhook — fallback when Kafka unavailable (custodial sweep)',
      body: {
        type: 'object',
        required: ['address', 'asset', 'amount'],
        properties: {
          depositId: { type: 'integer' },
          address: { type: 'string' },
          asset: { type: 'string', enum: ['avax', 'usdt'] },
          amount: { type: 'string' },
          txHash: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        400: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'object' } } },
        401: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' } } },
      },
    },
  }, handleCchainIncoming);
}

interface CchainIncomingBody {
  depositId?: number;
  address: string;
  asset: 'avax' | 'usdt';
  amount: string;
  txHash?: string;
}
