import { getPublicClient } from './cchainRpcService';

/**
 * In-process nonce allocator for a shared hot wallet.
 *
 * After broadcasting, a public RPC node often answers `eth_getTransactionCount`
 * with a `pending` count that does not yet include the just-sent transaction.
 * Pinning that stale value makes the next send fail with "nonce lower than the
 * current nonce of the account". We keep a local high-water mark per address and
 * hand out `max(chain_pending, local)`.
 *
 * Callers must hold the address nonce lock (`withNonceLock`) around allocate +
 * send, and call `resetNonces` when a submit fails so the gap is re-read from
 * chain instead of stalling every later transaction.
 */
const local = new Map<string, number>();

export async function allocateNonces(address: string, count = 1): Promise<number> {
  const key = address.toLowerCase();
  let pending: number;
  try {
    pending = await getPublicClient().getTransactionCount({
      address: address as `0x${string}`,
      blockTag: 'pending',
    });
  } catch {
    pending = local.get(key) ?? 0;
  }
  const base = Math.max(local.get(key) ?? 0, pending);
  local.set(key, base + count);
  return base;
}

export function resetNonces(address: string): void {
  local.delete(address.toLowerCase());
}

/** Test/ops helper: forget all tracked nonces. */
export function resetAllNonces(): void {
  local.clear();
}
