import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { bypassPayment } from '../services/orderService';
import { adminAuth } from '../middlewares/adminAuth';

interface BypassPaymentBody {
  admin_key: string;
  order_id: number;
}

export async function bypassRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: BypassPaymentBody }>('/bypass-payment', {
    schema: {
      tags: ['Bypass'],
      summary: 'Bypass buy order payment (dev/test only)',
      description: '**For testing only.** Skips SePay webhook confirmation for buy orders. Directly moves order to PROCESSING and triggers C-Chain crypto disbursement. Requires ADMIN_BOOTSTRAP_PASSWORD. Do not expose in production.',
      body: {
        type: 'object',
        required: ['admin_key', 'order_id'],
        properties: {
          admin_key: { type: 'string', description: 'Value of ADMIN_BOOTSTRAP_PASSWORD env var' },
          order_id: { type: 'integer', description: 'Numeric order ID to bypass' },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Payment bypassed successfully.',
          properties: { success: { type: 'boolean' } },
        },
        400: {
          type: 'object',
          description: 'Bypass failed.',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { admin_key, order_id } = req.body;
    const result = await bypassPayment(admin_key, order_id);
    if (result.error) {
      return reply.status(400).send({ success: false, error: result.error });
    }
    return reply.send({ success: true });
  });
}