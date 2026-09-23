import type { FastifyInstance } from 'fastify';
import { partnerAuth } from '../middlewares/partnerAuth';
import { handleVerifyPartner } from '../controllers/partnerController';

export async function partnerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/verify', {
    preHandler: partnerAuth,
    schema: {
      security: [{ PartnerAppKey: [] }],
      tags: ['Partners'],
      summary: 'Verify a Partner-App-Key',
      description: 'Validates the `partner-app-key` header and returns the resolved partner context (id, name, fee overrides). Used by web-be to authenticate partner-facing user routes without reading the partners table directly.',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              nullable: true,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                fee_buy: { type: 'number' },
                fee_sell: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          description: 'Missing or invalid partner key.',
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
  }, handleVerifyPartner);
}
