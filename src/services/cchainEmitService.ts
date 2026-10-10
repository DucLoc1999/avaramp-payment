import { notifyCchainDeposit } from './cchainOrderService';
import type { CchainDepositEvent } from './cchainEmitServiceTypes';

export type { CchainDepositEvent };

/**
 * Emit a confirmed C-Chain deposit: POSTs to the configured HTTP endpoint when
 * set, and always notifies the in-process order-correlation/sweep handler so
 * funds are not lost when no endpoint is configured.
 */
export async function emitCchainDeposit(
  event: CchainDepositEvent
): Promise<{ emitted: boolean }> {
  let delivered = false;

  if (process.env.CCHAIN_LISTENER_FALLBACK_URL) {
    try {
      const res = await fetch(process.env.CCHAIN_LISTENER_FALLBACK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CCHAIN_LISTENER_FALLBACK_AUTH_TOKEN
            ? { Authorization: `Bearer ${process.env.CCHAIN_LISTENER_FALLBACK_AUTH_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(Number(process.env.CALLBACK_TIMEOUT_MS || 10000)),
      });
      delivered = res.ok;
      if (!res.ok) console.error(`[CchainListener] Fallback POST failed: status=${res.status}`);
    } catch (err) {
      console.error(`[CchainListener] Fallback POST error: ${(err as Error).message}`);
    }
  }

  // In-process handler guarantees the deposit reaches the sweep/correlation step.
  try {
    await notifyCchainDeposit(event);
  } catch (err) {
    console.error(`[CchainListener] In-process handler error: ${(err as Error).message}`);
  }

  return { emitted: delivered };
}