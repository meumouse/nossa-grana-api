import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  IMPORT_EXTRACT_QUEUE_NAME,
  IMPORT_QUEUE_NAME,
  makeQueueConnection,
  type ConfirmImportJobData,
  type ExtractImportJobData,
} from '../lib/queue';
import { processConfirmBatch, processExtractBatch } from '../modules/imports/imports.service';

/**
 * Workers das filas de importação (BullMQ).
 *
 * - `import-extract`: lê o documento com IA em background (ver
 *   imports.service/processExtractBatch) — tira a extração de docs grandes do
 *   request HTTP.
 * - `import-confirm`: cria as transações dos itens aceitos (processConfirmBatch).
 *
 * Falhas marcam o lote como FAILED com a mensagem; relançar deixa o BullMQ
 * aplicar o retry. Compartilham a mesma conexão Redis.
 */
export function startImportWorker(db: PrismaClient, log: FastifyBaseLogger): () => Promise<void> {
  const connection = makeQueueConnection();
  // Cast: o BullMQ embute uma cópia própria do ioredis (tipo nominalmente
  // distinto da nossa), mas em runtime a instância é compatível.
  const conn = connection as unknown as ConnectionOptions;

  const extractWorker = new Worker<ExtractImportJobData>(
    IMPORT_EXTRACT_QUEUE_NAME,
    async (job: Job<ExtractImportJobData>) => {
      const { batchId, workspaceId, userId } = job.data;
      await processExtractBatch(db, { workspaceId, userId }, batchId);
    },
    // Extração é I/O de LLM (lenta); 2 em paralelo evita estourar rate-limit do
    // provider e o pool do Prisma.
    { connection: conn, concurrency: 2 },
  );

  extractWorker.on('completed', (job) => {
    log.info({ batchId: job.data.batchId }, 'Documento extraído (IA)');
  });
  extractWorker.on('failed', (job, err) => {
    log.error({ batchId: job?.data.batchId, err }, 'Falha ao extrair documento');
  });

  const confirmWorker = new Worker<ConfirmImportJobData>(
    IMPORT_QUEUE_NAME,
    async (job: Job<ConfirmImportJobData>) => {
      const { batchId, workspaceId, userId, defaultAccountId, defaultCreditCardId } = job.data;
      const imported = await processConfirmBatch(
        db,
        { workspaceId, userId },
        batchId,
        { defaultAccountId, defaultCreditCardId },
      );
      return { imported };
    },
    // Conservador: a confirmação faz N writes; 2 lotes em paralelo já dão vazão
    // sem competir demais com o pool do Prisma das requests.
    { connection: conn, concurrency: 2 },
  );

  confirmWorker.on('completed', (job, result: { imported: number }) => {
    log.info({ batchId: job.data.batchId, imported: result.imported }, 'Importação confirmada');
  });
  confirmWorker.on('failed', (job, err) => {
    log.error({ batchId: job?.data.batchId, err }, 'Falha ao confirmar importação');
  });

  log.info('Workers de importação iniciados (extração + confirmação, fila BullMQ)');

  return async () => {
    await Promise.all([extractWorker.close(), confirmWorker.close()]);
    await connection.quit();
  };
}
