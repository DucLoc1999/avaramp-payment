import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { priceRoutes } from './routes/priceRoutes';
import { configRoutes } from './routes/configRoutes';
import { orderRoutes } from './routes/orderRoutes';
import { webhookRoutes } from './routes/webhookRoutes';
import { adminRoutes } from './routes/adminRoutes';
import { bypassRoutes } from './routes/bypassRoutes';
import { cmsRoutes } from './routes/cmsRoutes';
import { landingRoutes } from './routes/landingRoutes';
import { partnerRoutes } from './routes/partnerRoutes';
import { errorHandler } from './middlewares/errorHandler';
import db from './db';
import { runMigrations } from './utils/migrationRunner';
import { testConnection } from './config/database';
import { logger } from './config/logger';
import { ensureBootstrapAdmin } from './services/adminService';
import { ensureBootstrapPartner } from './services/partnerService';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'partner-app-key'],
    credentials: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
    },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AvaRamp API',
        description: 'AvaRamp — price engine, fee management, SePay payment integration and Avalanche C-Chain settlement',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          SepayWebhookKey: { type: 'apiKey', in: 'header', name: 'Authorization' },
          BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          PartnerAppKey: { type: 'apiKey', in: 'header', name: 'partner-app-key', description: 'Partner App Key for client authentication' },
        },
      },
    },
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(errorHandler);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(adminRoutes);
  await app.register(bypassRoutes);
  await app.register(cmsRoutes, { prefix: '/cms' });
  await app.register(landingRoutes, { prefix: '/landing' });
  await app.register(priceRoutes, { prefix: '/api/rate' });
  await app.register(configRoutes, { prefix: '/config' });
  await app.register(orderRoutes, { prefix: '/api/orders' });
  await app.register(partnerRoutes, { prefix: '/api/partners' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });

  app.addHook('onReady', async () => {
    try {
      const { getPayoutAddress } = await import('./services/cchainPayoutAccount');
      try {
        const payoutWallet = await getPayoutAddress();
        logger.info({ payoutWallet }, 'Active C-Chain payout wallet (from KMS payout key config)');
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Could not resolve C-Chain payout wallet from GCP KMS');
      }

      await runMigrations();
      await ensureBootstrapAdmin();
      await ensureBootstrapPartner();

      await testConnection(db);
      logger.info('Database connection verified');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to connect to database');
      throw error;
    }
  });

  return app;
}
