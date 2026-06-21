import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  IMPORT_QUEUE_NAME,
  makeQueueConnection,
  type ConfirmImportJobData,
} from '../lib/queue';
import { processConfirmBatch } from '../modules/imports/imports.service';

/**
 * Worker da fila de confirmação de importação.
 *
 * Consome os jobs enfileirados por `confirmBatch` e cria as transações em
 * background (ver imports.service/processConfirmBatch). Falhas marcam o lote
 * como FAILED com a mensagem; relançar deixa o BullMQ aplicar o retry.
 */
export function startImportWorker(db: PrismaClient, log: FastifyBaseLogger): () => Promise<void> {
  const connection = makeQueueConnection();

  const worker = new Worker<ConfirmImportJobData>(
    IMPORT_QUEUE_NAME,
    async (job: Job<ConfirmImportJobData>) => {
      const { batchId, workspaceId, userId, defaultAccountId } = job.data;
      const imported = await processConfirmBatch(
        db,
        { workspaceId, userId },
        batchId,
        { defaultAccountId },
      );
      return { imported };
    },
    // Conservador: a confirmação faz N writes; 2 lotes em paralelo já dão vazão
    // sem competir demais com o pool do Prisma das requests.
    // Cast: o BullMQ embute uma cópia própria do ioredis (tipo nominalmente
    // distinto da nossa), mas em runtime a instância é compatível.
    { connection: connection as unknown as ConnectionOptions, concurrency: 2 },
  );

  worker.on('completed', (job, result: { imported: number }) => {
    log.info({ batchId: job.data.batchId, imported: result.imported }, 'Importação confirmada');
  });
  worker.on('failed', (job, err) => {
    log.error({ batchId: job?.data.batchId, err }, 'Falha ao confirmar importação');
  });

  log.info('Worker de importação iniciado (fila BullMQ)');

  return async () => {
    await worker.close();
    await connection.quit();
  };
}
