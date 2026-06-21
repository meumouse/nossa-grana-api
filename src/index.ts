import './load-env';
import { buildServer } from './server';
import { env, queueEnabled } from './env';
import { startScheduler } from './jobs/scheduler';
import { startImportWorker } from './jobs/import-worker';
import { closeImportQueue } from './lib/queue';

async function main(): Promise<void> {
  const app = await buildServer();

  // Jobs in-process (materializar recorrências + fechar faturas).
  const stopScheduler = startScheduler(app);

  // Worker da fila de importação (in-process; suficiente p/ 1 instância). Em
  // múltiplas instâncias, prefira rodar `npm run worker` à parte.
  const stopWorker = queueEnabled ? startImportWorker(app.prisma, app.log) : null;

  const shutdown = async (signal: string) => {
    app.log.info(`Recebido ${signal}, encerrando...`);
    stopScheduler();
    if (stopWorker) await stopWorker();
    await closeImportQueue();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
