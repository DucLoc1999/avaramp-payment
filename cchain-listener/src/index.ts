import 'dotenv/config';

const stdout = process.stdout as unknown as { _handle?: { setBlocking: (b: boolean) => void } };
const stderr = process.stderr as unknown as { _handle?: { setBlocking: (b: boolean) => void } };
if (stdout._handle && typeof stdout._handle.setBlocking === 'function') stdout._handle.setBlocking(true);
if (stderr._handle && typeof stderr._handle.setBlocking === 'function') stderr._handle.setBlocking(true);

import { startCchainListenerLoop, stopCchainListenerLoop } from '../../src/services/cchainListenerLoop';

let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('[CchainListener] Starting...');

  try {
    startCchainListenerLoop();
  } catch (error) {
    console.error('[CchainListener] Config error:', (error as Error).message);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[CchainListener] ${signal} received, shutting down gracefully...`);
    stopCchainListenerLoop();
    running = false;
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep alive.
  while (running) {
    await sleep(1000);
  }
}

void main();
