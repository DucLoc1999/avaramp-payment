import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SepayWebhookPayload } from '../models/types';
import { handleSepayWebhook as processSepayWebhook } from '../services/sepayService';
import { createErrorReply } from '../middlewares/errorHandler';
import { notifyCchainDeposit } from '../services/cchainOrderService';
import type { CchainDepositEvent } from '../services/cchainEmitServiceTypes';
import db from '../db';

export async function handleSepayWebhook(
  req: FastifyRequest<{ Body: SepayWebhookPayload }>,
  reply: FastifyReply,
  app: FastifyInstance,
) {
  try {
    await processSepayWebhook(req.body);
    reply.send({ success: true });
  } catch (err) {
    app.log.error({ err }, 'sepay webhook processing error');
    reply.code(500).send({ success: false, error: 'Processing failed' });
  }
}

interface CchainIncomingBody {
  depositId?: number;
  address: string;
  asset: 'avax' | 'usdt';
  amount: string;
  txHash?: string;
}

/** C-Chain listener fallback: accept a confirmed deposit fact and sweep/correlate it. */
export async function handleCchainIncoming(
  req: FastifyRequest<{ Body: CchainIncomingBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { address, asset, amount } = req.body;

  try {
    let depositId = req.body.depositId;
    if (!depositId) {
      const existing = await db('cchain_deposits')
        .where({ address, asset })
        .orderBy('created_at', 'desc')
        .first();
      if (existing) {
        depositId = Number(existing.id);
      } else {
        // No recorded deposit — create a confirmed deposit so it can be swept.
        const [inserted] = await db('cchain_deposits')
          .insert({
            address,
            asset,
            amount,
            tx_hash: req.body.txHash ?? null,
            status: 'confirmed',
          })
          .returning('id');
        depositId = Number(inserted.id);
      }
    }

    const event: CchainDepositEvent = {
      depositId,
      address,
      asset,
      amount,
      txHash: req.body.txHash,
    };

    const result = await notifyCchainDeposit(event);
    return reply.send({ success: true, swept: result.swept, completed: result.completed });
  } catch (err) {
    const message = (err as Error).message;
    return createErrorReply(reply, 'CHAIN_EVENT_MISMATCH', message, req.id);
  }
}