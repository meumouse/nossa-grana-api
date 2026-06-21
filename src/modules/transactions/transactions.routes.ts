import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../../plugins/workspace';
import {
  analyzeStatement,
  createTransaction,
  createTransfer,
  deleteTransaction,
  listTransactions,
  payTransaction,
  unpayTransaction,
  updateTransaction,
} from './transactions.service';
import {
  analyzeSchema,
  createTxSchema,
  listQuerySchema,
  paySchema,
  transferSchema,
  updateTxSchema,
} from './transactions.schemas';

export default async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const q = listQuerySchema.parse(request.query);
    return listTransactions(app.prisma, request.workspace!.id, q);
  });

  // Contas a pagar / a receber: PENDING com dueDate. ?overdue=true filtra vencidas.
  app.get('/payables', async (request) => {
    const query = z
      .object({
        kind: z.enum(['payable', 'receivable']).optional(),
        overdue: z.coerce.boolean().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(request.query);

    const items = await app.prisma.transaction.findMany({
      where: {
        workspaceId: request.workspace!.id,
        deletedAt: null,
        status: 'PENDING',
        dueDate: {
          not: null,
          ...(query.overdue ? { lt: new Date() } : {}),
          ...(query.to ? { lte: query.to } : {}),
        },
        ...(query.kind === 'payable' ? { type: 'EXPENSE' } : {}),
        ...(query.kind === 'receivable' ? { type: 'INCOME' } : {}),
      },
      include: {
        category: { select: { id: true, name: true, color: true, icon: true } },
        account: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: 'asc' },
    });

    return { items };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createTxSchema.parse(request.body);
    const tx = await createTransaction(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      body,
    );
    return reply.code(201).send({ transaction: tx });
  });

  // Verificação de inconsistências com IA. O cliente envia o extrato (inclui
  // lançamentos offline); o servidor só roda a IA e devolve os achados.
  app.post('/analyze', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const body = analyzeSchema.parse(request.body);
    return analyzeStatement(app.prisma, request.workspace!.id, body);
  });

  app.post('/transfer', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = transferSchema.parse(request.body);
    const result = await createTransfer(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      body,
    );
    return reply.code(201).send(result);
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateTxSchema.parse(request.body);
    const tx = await updateTransaction(app.prisma, { workspaceId: request.workspace!.id }, id, body);
    return { transaction: tx };
  });

  app.post('/:id/pay', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = paySchema.parse(request.body ?? {});
    const tx = await payTransaction(app.prisma, request.workspace!.id, id, body.paidAt);
    return { transaction: tx };
  });

  app.post('/:id/unpay', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const tx = await unpayTransaction(app.prisma, request.workspace!.id, id);
    return { transaction: tx };
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteTransaction(app.prisma, request.workspace!.id, id);
    return reply.code(204).send();
  });
}
