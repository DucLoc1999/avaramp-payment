import type { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    retriable: boolean;
    trace_id: string;
  };
}

function buildError(code: string, message: string, retriable: boolean, statusCode: number): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      retriable,
      trace_id: '',
    },
  };
}

export const ErrorCodes = {
  ORDER_NOT_FOUND: { code: 'ORDER_NOT_FOUND', statusCode: 404, retriable: false },
  INVALID_AMOUNT: { code: 'INVALID_AMOUNT', statusCode: 400, retriable: false },
  CANCEL_NOT_ALLOWED: { code: 'CANCEL_NOT_ALLOWED', statusCode: 409, retriable: false },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', statusCode: 400, retriable: false },
  UNAUTHORIZED: { code: 'UNAUTHORIZED', statusCode: 401, retriable: false },
  AUTH_NOT_CONFIGURED: { code: 'AUTH_NOT_CONFIGURED', statusCode: 503, retriable: true },
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', statusCode: 500, retriable: true },
  CHAIN_EVENT_MISMATCH: { code: 'CHAIN_EVENT_MISMATCH', statusCode: 400, retriable: false },
  UNSUPPORTED_TOKEN: { code: 'UNSUPPORTED_TOKEN', statusCode: 400, retriable: false },
  INSUFFICIENT_LIQUIDITY: { code: 'INSUFFICIENT_LIQUIDITY', statusCode: 409, retriable: false },
  RESERVATION_NOT_READY: { code: 'RESERVATION_NOT_READY', statusCode: 503, retriable: true },
  MAX_ORDER_EXCEEDED: { code: 'MAX_ORDER_EXCEEDED', statusCode: 400, retriable: false },
  PARTNER_NOT_FOUND: { code: 'PARTNER_NOT_FOUND', statusCode: 404, retriable: false },
  USER_NOT_FOUND: { code: 'USER_NOT_FOUND', statusCode: 404, retriable: false },
  PAYMENT_METHOD_NOT_FOUND: { code: 'PAYMENT_METHOD_NOT_FOUND', statusCode: 404, retriable: false },
} as const;

export function createErrorReply(
  reply: FastifyReply,
  code: keyof typeof ErrorCodes | string,
  message: string,
  traceId: string
): FastifyReply {
  const errorDef = ErrorCodes[code as keyof typeof ErrorCodes];
  const statusCode = errorDef?.statusCode ?? 500;
  const retriable = errorDef?.retriable ?? true;
  const errorCode = errorDef?.code ?? code;

  const response: ErrorResponse = {
    success: false,
    error: {
      code: errorCode,
      message,
      retriable,
      trace_id: traceId,
    },
  };

  return reply.status(statusCode).header('X-Trace-ID', traceId).send(response);
}

export async function errorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const traceId = request.id;

    if (error.validation) {
      return createErrorReply(reply, 'VALIDATION_ERROR', error.message, traceId);
    }

    app.log.error({ err: error, traceId });

    const statusCode = error.statusCode ?? 500;
    const message = error.message ?? 'Internal server error';

    return createErrorReply(reply, 'INTERNAL_ERROR', message, traceId);
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Trace-ID', request.id);
  });
}