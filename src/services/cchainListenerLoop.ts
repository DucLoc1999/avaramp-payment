import { loadCchainConfig } from '../config/cchain';
import {
  scanCchainDeposits,
  scanCchainNativeBalances,
  confirmPendingUsdtDeposits,
  listSweepableDeposits,
  reconcileOpenSellDeposits,
  type CchainDepositRow,
} from './cchainListenerService';
import { emitCchainDeposit } from './cchainEmitService';
import { logger } from '../config/logger';

let pollTimer: NodeJS.Timeout | null = null;
let running = false;

async function pollOnce(): Promise<{ detected: number; swept: number }> {
  let detected = 0;
  let swept = 0;

  try {
    const usdt = await scanCchainDeposits();
    const native = await scanCchainNativeBalances();
    detected += usdt.detected + native.detected;

    const confirmed = await confirmPendingUsdtDeposits();
    if (confirmed > 0) {
      logger.info({ confirmed }, '[CchainListener] Confirmed USDT deposit(s)');
    }

    const reconciled = await reconcileOpenSellDeposits();
    if (reconciled > 0) {
      logger.info({ reconciled }, '[CchainListener] Reconciled missed deposit(s)');
    }

    const sweepable = await listSweepableDeposits();
    for (const deposit of sweepable as CchainDepositRow[]) {
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
    }
  } catch (error) {
    logger.error({ error: (error as Error).message }, '[CchainListener] Poll error');
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
    void pollOnce();
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
