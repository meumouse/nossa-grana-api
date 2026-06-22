import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { env } from '../env';

/**
 * Fila de jobs (BullMQ + Redis).
 *
 * Usada hoje pela confirmação de importação: o request HTTP só enfileira e
 * retorna na hora; um worker (ver jobs/import-worker) cria as transações em
 * background. Isso evita que listas grandes estourem o tempo do request
 * (sintoma: 500 no /confirm enquanto os dados entram segundos depois).
 *
 * A fila é opcional: sem `REDIS_URL` o serviço de importação processa inline
 * (modo legado). Toda esta camada só é tocada quando `queueEnabled` é true.
 */

export const IMPORT_QUEUE_NAME = 'import-confirm';
export const IMPORT_EXTRACT_QUEUE_NAME = 'import-extract';

/** Dados do job de confirmação de um lote de importação. */
export interface ConfirmImportJobData {
  batchId: string;
  workspaceId: string;
  userId: string;
  /** Conta usada para itens que ficaram sem dono na revisão. */
  defaultAccountId?: string;
  /** Cartão usado para itens que ficaram sem dono na revisão. */
  defaultCreditCardId?: string;
}

/** Dados do job de extração (leitura do documento com IA) de um lote. */
export interface ExtractImportJobData {
  batchId: string;
  workspaceId: string;
  userId: string;
}

/**
 * Cria uma conexão ioredis com as opções exigidas pelo BullMQ.
 *
 * `maxRetriesPerRequest: null` é obrigatório: o BullMQ usa comandos bloqueantes
 * (BRPOPLPUSH) que não podem ter retry-limit. Por isso NÃO reaproveitamos a
 * conexão do cache (que usa maxRetriesPerRequest: 2).
 */
export function makeQueueConnection(): Redis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL não configurada — fila indisponível.');
  }
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let connection: Redis | null = null;
let queue: Queue<ConfirmImportJobData> | null = null;
let extractQueue: Queue<ExtractImportJobData> | null = null;

function getConnection(): Redis {
  if (!connection) connection = makeQueueConnection();
  return connection;
}

/** Opções padrão compartilhadas pelas filas de importação. */
const defaultJobOptions = {
  // Reprocessa em falhas transitórias (ex.: deadlock no banco, timeout do LLM).
  // O processamento é idempotente: itens já IMPORTED/extraídos são pulados.
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  // Higiene do Redis: limpa concluídos e mantém falhas por uma semana.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Fila singleton de confirmação de importação (lado do produtor). */
export function getImportQueue(): Queue<ConfirmImportJobData> {
  if (!queue) {
    queue = new Queue<ConfirmImportJobData>(IMPORT_QUEUE_NAME, {
      // Cast: o BullMQ embute uma cópia própria do ioredis (tipo nominalmente
      // distinto da nossa), mas em runtime a instância é compatível.
      connection: getConnection() as unknown as ConnectionOptions,
      defaultJobOptions,
    });
  }
  return queue;
}

/** Fila singleton de extração de documento (lado do produtor). */
export function getExtractQueue(): Queue<ExtractImportJobData> {
  if (!extractQueue) {
    extractQueue = new Queue<ExtractImportJobData>(IMPORT_EXTRACT_QUEUE_NAME, {
      connection: getConnection() as unknown as ConnectionOptions,
      defaultJobOptions,
    });
  }
  return extractQueue;
}

/**
 * Enfileira a confirmação de um lote.
 *
 * Sem jobId fixo de propósito: a duplicidade já é barrada antes (o lote vira
 * IMPORTING e um 2º confirm é rejeitado) e o processamento é idempotente por
 * dados (itens já IMPORTED deixam de ser ACCEPTED). Um jobId determinístico
 * impediria reprocessar um lote FAILED enquanto o job anterior estivesse retido.
 */
export async function enqueueConfirmImport(data: ConfirmImportJobData): Promise<void> {
  await getImportQueue().add('confirm', data);
}

/**
 * Enfileira a extração (leitura com IA) de um lote.
 *
 * Sem jobId fixo de propósito (mesma razão de enqueueConfirmImport): a
 * duplicidade é barrada antes (o lote vira PROCESSING) e o processamento é
 * idempotente — reprocessar limpa os itens anteriores antes de recriar.
 */
export async function enqueueExtractImport(data: ExtractImportJobData): Promise<void> {
  await getExtractQueue().add('extract', data);
}

/** Fecha as filas e a conexão do produtor (chamado no shutdown). */
export async function closeImportQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (extractQueue) {
    await extractQueue.close();
    extractQueue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
