import { loadCchainConfig } from '../config/cchain';
import {
  scanCchainDeposits,
  scanCchainNativeBalances,
  confirmPendingUsdtDeposits,
  listSweepableDeposits,
  reconcileSellDepositBalances,
  type CchainDepositRow,
} from './cchainListenerService';
import { emitCchainDeposit } from './cchainEmitService';
import { logger } from '../config/logger';

let pollTimer: NodeJS.Timeout | null = null;
let running = false;
let polling = false;

/**
 * Run one poll stage, containing its failures to that stage.
 *
 * Stages used to share a single try/catch, so a throw in the first stage (a
 * timed-out `eth_getLogs` on one custodial address) silently skipped the native
 * scan, confirmation, reconciliation AND the sweep stage for as long as the
 * failure persisted. Sweeps are what move user funds, so a scan-stage failure
 * must never be able to stop them.
 */
async function runStage<T>(stage: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.error({ stage, error: (error as Error).message }, '[CchainListener] Stage failed');
    return fallback;
  }
}

async function pollOnce(): Promise<{ detected: number; swept: number }> {
  let detected = 0;
  let swept = 0;

  const usdt = await runStage(
    'scanCchainDeposits',
    () => scanCchainDeposits(),
    { detected: 0, confirmed: 0 }
  );
  const native = await runStage(
    'scanCchainNativeBalances',
    () => scanCchainNativeBalances(),
    { detected: 0 }
  );
  detected += usdt.detected + native.detected;

  const confirmed = await runStage(
    'confirmPendingUsdtDeposits',
    () => confirmPendingUsdtDeposits(),
    0
  );
  if (confirmed > 0) {
    logger.info({ confirmed }, '[CchainListener] Confirmed USDT deposit(s)');
  }

  const reconciled = await runStage(
    'reconcileSellDepositBalances',
    () => reconcileSellDepositBalances(),
    0
  );
  if (reconciled > 0) {
    logger.info({ reconciled }, '[CchainListener] Reconciled missed deposit(s)');
  }

  const sweepable = await runStage('listSweepableDeposits', () => listSweepableDeposits(), []);
  for (const deposit of sweepable as CchainDepositRow[]) {
    try {
      logger.info(
        { depositId: deposit.id, asset: deposit.asset, amount: deposit.amount, address: deposit.address },
        '[CchainListener] Emitting sweepable deposit',
      );
      await emitCchainDeposit({
        depositId: deposit.id,
        address: deposit.address,
        asset: deposit.asset,
        amount: deposit.amount,
        orderId: deposit.order_id,
        txHash: deposit.tx_hash,
      });
      swept += 1;
    } catch (error) {
      // One bad deposit must not strand the rest of the queue.
      logger.error(
        { depositId: deposit.id, error: (error as Error).message },
        '[CchainListener] Sweep emit failed',
      );
    }
  }

  return { detected, swept };
}

export function isCchainListenerLoopRunning(): boolean {
  return running;
}

/**
 * Start the C-Chain custodial deposit poll loop in the current process.
 *
 * Throws if the C-Chain config is invalid; callers decide whether to abort
 * (standalone worker) or continue without the loop (API server). Calling it
 * twice is a no-op — only one loop runs per process.
 *
 * Only enable this in one process per deployment: each running loop polls the
 * C-Chain independently, so multiple API replicas with the loop enabled will
 * duplicate scans.
 */
export function startCchainListenerLoop(): void {
  if (running) {
    logger.warn('[CchainListener] Loop already running; ignoring duplicate start');
    return;
  }

  const config = loadCchainConfig();

  running = true;
  logger.info(
    {
      rpcBaseUrl: config.rpcBaseUrl,
      chainId: config.chainId,
      nativeUsdtAddress: config.nativeUsdtAddress,
      pollIntervalMs: config.pollIntervalMs,
    },
    '[CchainListener] Starting loop',
  );

  const runPoll = (): void => {
    // A poll that emits sweeps can take longer than the interval (the HTTP
    // delivery to the in-process webhook is awaited). Without this guard the next
    // tick starts while the previous is still sweeping, re-selects the same
    // not-yet-marked-swept deposit, and both sweeps race the same nonce.
    if (polling) {
      logger.warn('[CchainListener] Previous poll still running; skipping tick');
      return;
    }
    polling = true;
    void pollOnce().finally(() => {
      polling = false;
    });
  };

  runPoll();
  pollTimer = setInterval(runPoll, config.pollIntervalMs);
}

export function stopCchainListenerLoop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (running) {
    logger.info('[CchainListener] Loop stopped');
  }
  running = false;
}
