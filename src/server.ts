import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { corsOrigins, env } from './env';
import { buildLoggerOptions } from './lib/logger';
import prismaPlugin from './plugins/prisma';
import authPlugin from './plugins/auth';
import errorHandler from './plugins/error-handler';
import { registerRoutes } from './routes';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(),
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  // Upload de documentos para importação (extratos, comprovantes).
  await app.register(multipart, {
    limits: { fileSize: env.IMPORT_MAX_FILE_MB * 1024 * 1024, files: 1 },
  });

  // Infra
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(errorHandler);

  // Health check (sem auth). logLevel 'silent' evita poluir o log com o
  // polling de health do orquestrador/load balancer.
  app.get('/health', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    time: new Date().toISOString(),
  }));

  // API
  await app.register(registerRoutes, { prefix: '/api' });

  return app;
}
