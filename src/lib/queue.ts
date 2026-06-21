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

function getConnection(): Redis {
  if (!connection) connection = makeQueueConnection();
  return connection;
}

/** Fila singleton de confirmação de importação (lado do produtor). */
export function getImportQueue(): Queue<ConfirmImportJobData> {
  if (!queue) {
    queue = new Queue<ConfirmImportJobData>(IMPORT_QUEUE_NAME, {
      // Cast: o BullMQ embute uma cópia própria do ioredis (tipo nominalmente
      // distinto da nossa), mas em runtime a instância é compatível.
      connection: getConnection() as unknown as ConnectionOptions,
      defaultJobOptions: {
        // Reprocessa em falhas transitórias (ex.: deadlock no banco). O
        // processamento é idempotente: itens já IMPORTED são pulados.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        // Higiene do Redis: limpa concluídos e mantém falhas por uma semana.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return queue;
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

/** Fecha a fila e a conexão do produtor (chamado no shutdown). */
export async function closeImportQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
