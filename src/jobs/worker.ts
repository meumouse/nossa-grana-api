import '../load-env';
import pino from 'pino';
import { env, queueEnabled } from '../env';
import { prisma } from '../prisma';
import { closeImportQueue } from '../lib/queue';
import { startImportWorker } from './import-worker';

/**
 * Entry point do worker standalone: `npm run worker`.
 *
 * Use quando a API roda com múltiplas instâncias — em vez do worker in-process
 * (que o index.ts sobe junto da API), centralize o processamento da fila aqui.
 * Requer `REDIS_URL` configurada.
 */
async function main(): Promise<void> {
  if (!queueEnabled) {
    // eslint-disable-next-line no-console
    console.error('✗ REDIS_URL não configurada — o worker exige a fila (Redis).');
    process.exit(1);
  }

  const log = pino({ level: env.LOG_LEVEL });
  const stopWorker = startImportWorker(prisma, log);

  const shutdown = async (signal: string) => {
    log.info(`Recebido ${signal}, encerrando worker...`);
    await stopWorker();
    await closeImportQueue();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
