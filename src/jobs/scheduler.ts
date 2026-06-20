import type { FastifyInstance } from 'fastify';
import { runMaintenanceJobs } from './jobs';

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Agendador in-process simples (suficiente p/ 1 instância). Em produção com
 * múltiplas instâncias, prefira um cron externo chamando `npm run jobs` para
 * evitar execução concorrente.
 */
export function startScheduler(app: FastifyInstance): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runMaintenanceJobs(app.prisma);
      app.log.info({ result }, 'Jobs de manutenção executados');
    } catch (err) {
      app.log.error({ err }, 'Falha nos jobs de manutenção');
    } finally {
      running = false;
    }
  };

  // Roda logo após subir e depois a cada 6h.
  const initial = setTimeout(() => void tick(), 5_000);
  const interval = setInterval(() => void tick(), SIX_HOURS);

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
