import 'dotenv/config';
import { buildApp } from './app';
import { logger } from './config/logger';
import { appConfig } from './config/app';
import { initCchainPayout, sweepStuckCchainPayouts } from './services/cchainPayoutService';
import { startCchainListenerLoop, stopCchainListenerLoop } from './services/cchainListenerLoop';
import { initKafka, disconnectKafka } from './services/queueService';
import { startSnapshotScheduler } from './services/snapshotLandingPageScheduler';
import { startOrderExpiryScheduler } from './services/orderExpiryScheduler';
import { refresh as refreshConfig } from './services/configService';
import { initReservationService, shutdownReservationService, startReservationSchedulers } from './services/reservationService';
import { runMigrations } from './utils/migrationRunner';
import db from './db';

let app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never;
let snapshotInterval: NodeJS.Timeout | undefined;
let expiryInterval: NodeJS.Timeout | undefined;
let reservationIntervals: NodeJS.Timeout[] = [];

async function healthCheck() {
  try {
    await db.raw('SELECT 1');
    logger.info('DB connection OK');
  } catch (err) {
    throw new Error(`DB connection failed: ${(err as Error).message}`);
  }
}

async function checkKafkaConnection() {
  await initKafka();
}


async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    await disconnectKafka();
    if (snapshotInterval) clearInterval(snapshotInterval);
    if (expiryInterval) clearInterval(expiryInterval);
    for (const interval of reservationIntervals) clearInterval(interval);
    await shutdownReservationService();
    stopCchainListenerLoop();
    await db.destroy();
    if (app && app.close) {
      await app.close();
    }
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

async function start() {
  // Migrations must run before any DB reads (config table, etc.). app.onReady
  // also runs them, but the startup sequence below reads the DB first.
  await runMigrations();
  await refreshConfig();
  await healthCheck();
  await checkKafkaConnection();
  await initReservationService();

  // Buy payouts settle on the C-Chain; resolve the payout wallet and verify the
  // USDT contract precision at startup.
  try {
    await initCchainPayout();
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'C-Chain payout initialization failed'
    );
  }

  // Recover C-Chain payouts left in-flight after a crash/restart.
  await sweepStuckCchainPayouts();

  // Optionally run the custodial deposit poll loop in this process instead of a
  // separate `cchain-listener` worker. Enable in exactly one process per
  // deployment (see CCHAIN_LISTENER_IN_API).
  if (process.env.CCHAIN_LISTENER_IN_API === 'true') {
    try {
      startCchainListenerLoop();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'C-Chain listener loop failed to start; run the standalone cchain-listener worker instead'
      );
    }
  }

  const builtApp = await buildApp();
  app = builtApp as typeof app;

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  const port = appConfig.port;
  const host = appConfig.host;

  await app.listen({ port, host });
  snapshotInterval = startSnapshotScheduler();
  expiryInterval = startOrderExpiryScheduler();
  reservationIntervals = startReservationSchedulers();
}

start();