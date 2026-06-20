import type { PrismaClient } from '@prisma/client';
import { materializeAll } from '../modules/recurring/recurring.service';
import { closeDueInvoices } from '../modules/invoices/invoices.service';

/**
 * Executa os jobs de manutenção uma vez:
 *  - materializa recorrências futuras (passo 5 da arquitetura)
 *  - fecha faturas no fim do ciclo e marca vencidas
 */
export async function runMaintenanceJobs(db: PrismaClient): Promise<{
  materialized: number;
  invoicesClosed: number;
  invoicesOverdue: number;
}> {
  const materialized = await materializeAll(db);
  const { closed, overdue } = await closeDueInvoices(db);
  return { materialized, invoicesClosed: closed, invoicesOverdue: overdue };
}
