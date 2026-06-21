import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { Decimal } from '../../lib/money';
import { createCardPayment } from '../transactions/transactions.service';

const paySchema = z.object({
  paymentAccountId: z.string().optional(),
  paidAt: z.coerce.date().optional(),
});

async function invoiceTotal(app: FastifyInstance, invoiceId: string): Promise<Decimal> {
  const agg = await app.prisma.transaction.aggregate({
    where: { creditCardInvoiceId: invoiceId, type: 'EXPENSE', deletedAt: null },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? new Decimal(0);
}

export default async function invoicesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const { creditCardId, status } = z
      .object({
        creditCardId: z.string().optional(),
        status: z.enum(['OPEN', 'CLOSED', 'PAID', 'OVERDUE']).optional(),
      })
      .parse(request.query);

    const invoices = await app.prisma.creditCardInvoice.findMany({
      where: {
        workspaceId: request.workspace!.id,
        ...(creditCardId ? { creditCardId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { closingDate: 'desc' },
    });

    const withTotals = await Promise.all(
      invoices.map(async (inv) => ({ ...inv, total: await invoiceTotal(app, inv.id) })),
    );
    return { invoices: withTotals };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const invoice = await app.prisma.creditCardInvoice.findFirst({
      where: { id, workspaceId: request.workspace!.id },
      include: {
        creditCard: { select: { id: true, name: true, paymentAccountId: true } },
        transactions: {
          where: { deletedAt: null },
          include: { category: { select: { id: true, name: true, color: true, icon: true } } },
          orderBy: { date: 'asc' },
        },
      },
    });
    if (!invoice) throw NotFound('Fatura não encontrada');
    return { invoice: { ...invoice, total: await invoiceTotal(app, invoice.id) } };
  });

  /**
   * Pagar a fatura = TRANSFER da conta corrente → cartão, marcando PAID.
   * (arquitetura §5: não "some" dinheiro; é um movimento entre contas.)
   */
  app.post('/:id/pay', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = paySchema.parse(request.body ?? {});

    const invoice = await app.prisma.creditCardInvoice.findFirst({
      where: { id, workspaceId: request.workspace!.id },
      include: { creditCard: { select: { id: true, name: true, paymentAccountId: true } } },
    });
    if (!invoice) throw NotFound('Fatura não encontrada');
    if (invoice.status === 'PAID') throw BadRequest('Fatura já paga');

    const paymentAccountId = body.paymentAccountId ?? invoice.creditCard.paymentAccountId;
    if (!paymentAccountId) {
      throw BadRequest('Defina a conta de pagamento (paymentAccountId) ou configure-a no cartão');
    }

    const total = await invoiceTotal(app, invoice.id);
    if (total.lte(0)) throw BadRequest('Fatura sem valor a pagar');

    const paidAt = body.paidAt ?? new Date();

    const transfer = await createCardPayment(
      app.prisma,
      { workspaceId: request.workspace!.id, userId: request.userId! },
      {
        fromAccountId: paymentAccountId,
        creditCardId: invoice.creditCard.id,
        amount: Number(total.toFixed(2)),
        description: `Pagamento fatura ${invoice.creditCard.name}`,
        date: paidAt,
        status: 'COMPLETED',
      },
    );

    const updated = await app.prisma.creditCardInvoice.update({
      where: { id },
      data: { status: 'PAID', paidAt },
    });

    return { invoice: updated, transfer };
  });

  /**
   * Exclui uma fatura. Hard delete: os lançamentos vinculados são preservados e
   * apenas desvinculados (Transaction.creditCardInvoiceId tem onDelete: SetNull).
   * O ciclo (creditCardId, closingDate) volta a ficar livre e é rematerializado
   * sob demanda na próxima compra/parcela do período.
   */
  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const invoice = await app.prisma.creditCardInvoice.findFirst({
      where: { id, workspaceId: request.workspace!.id },
      select: { id: true },
    });
    if (!invoice) throw NotFound('Fatura não encontrada');

    await app.prisma.creditCardInvoice.delete({ where: { id } });
    return reply.code(204).send();
  });
}
