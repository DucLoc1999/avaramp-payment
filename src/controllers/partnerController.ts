import type { FastifyReply, FastifyRequest } from 'fastify';
import { createPartner, findPartnerById, listPartners, updatePartner, type PartnerRecord } from '../services/partnerService';
import { createErrorReply } from '../middlewares/errorHandler';

type PartnerBody = {
  name: string;
  fee_buy: number;
  fee_sell: number;
  active?: boolean;
};

function serializePartner(partner: PartnerRecord) {
  return {
    id: partner.id,
    name: partner.name,
    key: partner.key,
    fee_buy: partner.fee_buy,
    fee_sell: partner.fee_sell,
    active: partner.active,
    creator: partner.creator,
    created_at: partner.created_at instanceof Date ? partner.created_at.toISOString() : String(partner.created_at),
    updated_at: partner.updated_at instanceof Date
      ? partner.updated_at.toISOString()
      : partner.updated_at
        ? String(partner.updated_at)
        : null,
  };
}

export async function handleCreatePartner(
  req: FastifyRequest<{ Body: PartnerBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body ?? ({} as PartnerBody);

  if (!body.name || typeof body.name !== 'string') {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'name is required', req.id);
  }
  if (typeof body.fee_buy !== 'number' || body.fee_buy < 0) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'fee_buy must be a non-negative number', req.id);
  }
  if (typeof body.fee_sell !== 'number' || body.fee_sell < 0) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'fee_sell must be a non-negative number', req.id);
  }

  const partner = await createPartner({
    name: body.name,
    fee_buy: body.fee_buy,
    fee_sell: body.fee_sell,
    active: body.active ?? true,
    creator: req.admin?.id ?? null,
  });

  reply.code(201).send({ success: true, data: serializePartner(partner) });
}

export async function handleListPartners(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const partners = await listPartners();
  reply.send({ success: true, data: partners.map(serializePartner) });
}

/**
 * Partner-authenticated key check. `partnerAuth` has already validated the
 * `partner-app-key` header, so this echoes the resolved partner context for
 * callers that need to verify a key (e.g. web-be).
 */
export async function handleVerifyPartner(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.send({ success: true, data: req.partner ?? null });
}

export async function handleGetPartner(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const partner = await findPartnerById(req.params.id);
  if (!partner) {
    return createErrorReply(reply, 'PARTNER_NOT_FOUND', 'Partner not found', req.id);
  }

  reply.send({ success: true, data: serializePartner(partner) });
}

type PartnerPatchBody = {
  name?: string;
  fee_buy?: number;
  fee_sell?: number;
  active?: boolean;
};

export async function handleUpdatePartner(
  req: FastifyRequest<{ Params: { id: string }; Body: PartnerPatchBody }>,
  reply: FastifyReply,
): Promise<void> {
  const body = req.body ?? ({} as PartnerPatchBody);

  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'name must be a non-empty string', req.id);
  }
  if (body.fee_buy !== undefined && (typeof body.fee_buy !== 'number' || body.fee_buy < 0)) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'fee_buy must be a non-negative number', req.id);
  }
  if (body.fee_sell !== undefined && (typeof body.fee_sell !== 'number' || body.fee_sell < 0)) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'fee_sell must be a non-negative number', req.id);
  }

  const existing = await findPartnerById(req.params.id);
  if (!existing) {
    return createErrorReply(reply, 'PARTNER_NOT_FOUND', 'Partner not found', req.id);
  }

  const patch: PartnerPatchBody = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.fee_buy !== undefined) patch.fee_buy = body.fee_buy;
  if (body.fee_sell !== undefined) patch.fee_sell = body.fee_sell;
  if (body.active !== undefined) patch.active = body.active;

  if (Object.keys(patch).length === 0) {
    return createErrorReply(reply, 'VALIDATION_ERROR', 'No fields to update', req.id);
  }

  const updated = await updatePartner(req.params.id, patch);
  if (!updated) {
    return createErrorReply(reply, 'PARTNER_NOT_FOUND', 'Partner not found', req.id);
  }
  reply.send({ success: true, data: serializePartner(updated) });
}
