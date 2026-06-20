import './load-env';
import { buildServer } from './server';
import { env } from './env';
import { startScheduler } from './jobs/scheduler';

async function main(): Promise<void> {
  const app = await buildServer();

  // Jobs in-process (materializar recorrências + fechar faturas).
  const stopScheduler = startScheduler(app);

  const shutdown = async (signal: string) => {
    app.log.info(`Recebido ${signal}, encerrando...`);
    stopScheduler();
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
