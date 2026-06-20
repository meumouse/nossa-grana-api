import '../load-env';
import { prisma } from '../prisma';
import { runMaintenanceJobs } from './jobs';

/** Entry point p/ cron externo: `npm run jobs`. Roda os jobs uma vez e sai. */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('▶ Executando jobs de manutenção...');
  const result = await runMaintenanceJobs(prisma);
  // eslint-disable-next-line no-console
  console.log('✔ Concluído:', result);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('✗ Falha nos jobs:', err);
  await prisma.$disconnect();
  process.exit(1);
});
