/**
 * Per-address transaction serialization.
 *
 * Two senders can share one EVM address: the Master Wallet pays both the
 * `permit`+`transferFrom` sell sweeps and — once the payout wallet is merged
 * into it — the buy payouts. viem fetches the pending nonce on every call, so
 * two concurrent sends from the same address race and one is rejected as a
 * replacement. Queueing per (lowercased) address keeps nonces monotonic.
 */

const tails = new Map<string, Promise<unknown>>();

/**
 * Queue async work under an arbitrary key. The next task starts only after the
 * previous one settles (resolved or rejected).
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous task resolved or rejected.
  const run = prev.then(fn, fn);
  const tail: Promise<unknown> = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Only drop the entry when nothing newer was queued behind us, otherwise the
    // map grows one entry per key (custodial addresses are per-order).
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/** Queue async work per EVM address so nonces stay monotonic. */
export function withNonceLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`nonce:${address.toLowerCase()}`, fn);
}
