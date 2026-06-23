import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { addMonths } from '../../lib/dates';
import { Decimal } from '../../lib/money';
import { txShareSchema } from '../sync/sync.schemas';
import { ensureInvoicesForDates, pruneEmptyOpenInvoices } from '../invoices/invoices.service';
import { connectTagsToTransactions, validWorkspaceTagIds } from '../../lib/tags';

/** Dados de ciclo do cartão dono do parcelamento (null se for conta). */
type OwnerCard = {
  id: string;
  workspaceId: string;
  statementClosingDay: number | null;
  paymentDueDay: number | null;
};

const createSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    // Dono das parcelas: conta OU cartão (exatamente um). Parcelar no cartão é
    // o caso comum.
    accountId: z.string().min(1).optional(),
    creditCardId: z.string().min(1).optional(),
    description: z.string().min(1).max(200),
    totalAmount: z.coerce.number().positive(),
    installments: z.number().int().min(2).max(360),
    // Parcela em que o parcelamento se encontra (1 = nova compra). As parcelas
    // anteriores a esta são criadas já como pagas (COMPLETED). `firstDueDate`
    // representa o vencimento DESTA parcela.
    startInstallment: z.coerce.number().int().min(1).optional().default(1),
    firstDueDate: z.coerce.date(),
    categoryId: z.string().nullable().optional(),
    // Divisão entre pessoas. shares inclui o dono (owner: true). Lista vazia/ausente
    // = sem divisão. shareCount default = nº de participantes informados.
    shares: z.array(txShareSchema).max(100).nullable().optional(),
    shareCount: z.number().int().min(1).nullable().optional(),
    // Tags (ids do servidor) aplicadas ao plano e propagadas a cada parcela.
    tagIds: z.array(z.string()).optional(),
  })
  .refine((b) => b.startInstallment <= b.installments, {
    message: 'A parcela inicial não pode ser maior que o total de parcelas',
    path: ['startInstallment'],
  })
  .refine((b) => (b.accountId ? 1 : 0) + (b.creditCardId ? 1 : 0) === 1, {
    message: 'Informe exatamente um entre accountId e creditCardId',
    path: ['accountId'],
  });

type ShareRow = { name: string; paid: boolean; owner?: boolean; userId?: string | null };

/**
 * Normaliza o rateio do parcelamento: garante exatamente um dono (pago) no topo.
 * Cada parcela recebe depois um clone deste modelo, com estado de pagamento
 * independente. Devolve `null` quando não há ao menos uma outra pessoa.
 */
function normalizeShares(raw: z.infer<typeof createSchema>['shares']): ShareRow[] | null {
  if (!raw || raw.length === 0) return null;
  const owner = raw.find((s) => s.owner);
  const others = raw.filter((s) => !s.owner);
  if (others.length === 0) return null;
  const rest: ShareRow[] = others.map((s) => ({ name: s.name, paid: s.paid, userId: s.userId ?? null }));
  return owner ? [{ name: owner.name, paid: true, owner: true }, ...rest] : rest;
}

/** Vencimentos das parcelas pendentes (>= inicial) — as que entram em fatura. */
function pendingDueDates(planFirstDue: Date, count: number, startInstallment: number): Date[] {
  const dues: Date[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i + 1 >= startInstallment) dues.push(addMonths(planFirstDue, i));
  }
  return dues;
}

/** Divide o total em N parcelas (centavos do resto vão na última). */
function splitAmount(total: Decimal, n: number): Decimal[] {
  const base = total.div(n).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const parts = Array.from({ length: n - 1 }, () => base);
  const last = total.minus(base.times(n - 1));
  return [...parts, last];
}

/**
 * Garante que a conta/cartão informado pertence ao workspace. Devolve os dados
 * de ciclo do cartão (p/ vincular parcelas a faturas) ou null quando for conta.
 */
async function assertOwner(
  app: FastifyInstance,
  workspaceId: string,
  body: z.infer<typeof createSchema>,
): Promise<OwnerCard | null> {
  if (body.creditCardId) {
    const card = await app.prisma.creditCard.findFirst({
      where: { id: body.creditCardId, workspaceId, deletedAt: null },
      select: { id: true, workspaceId: true, statementClosingDay: true, paymentDueDay: true },
    });
    if (!card) throw BadRequest('Cartão inválido para este workspace');
    return card;
  }
  const account = await app.prisma.account.findFirst({
    where: { id: body.accountId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!account) throw BadRequest('Conta inválida para este workspace');
  return null;
}

/**
 * Monta as N parcelas (Transaction) de um plano. Parcelas anteriores à inicial
 * entram quitadas (COMPLETED); cada parcela recebe um clone do rateio com estado
 * de pagamento próprio.
 */
function buildParcelaRows(opts: {
  workspaceId: string;
  userId: string;
  planId: string;
  body: z.infer<typeof createSchema>;
  amounts: Decimal[];
  planFirstDue: Date;
  shared: boolean;
  shareCount: number | null;
  shares: ShareRow[] | null;
  // Fatura (futura) de cada parcela, por data de vencimento. Só para cartão.
  invoiceByDue: Map<number, string> | null;
}) {
  const { workspaceId, userId, planId, body, amounts, planFirstDue, shared, shareCount, shares, invoiceByDue } =
    opts;
  return amounts.map((amount, i) => {
    const number = i + 1;
    const due = addMonths(planFirstDue, i);
    const isPaid = number < body.startInstallment;
    return {
      workspaceId,
      accountId: body.accountId ?? null,
      creditCardId: body.creditCardId ?? null,
      type: 'EXPENSE' as const,
      status: isPaid ? ('COMPLETED' as const) : ('PENDING' as const),
      paidAt: isPaid ? due : null,
      amount,
      description: `${body.description} (${number}/${body.installments})`,
      categoryId: body.categoryId ?? null,
      date: due,
      dueDate: due,
      installmentPlanId: planId,
      installmentNumber: number,
      // Parcelas já pagas (anteriores à inicial) são histórico e não entram em
      // fatura; as pendentes caem na fatura futura do seu ciclo.
      creditCardInvoiceId: isPaid ? null : invoiceByDue?.get(due.getTime()) ?? null,
      createdById: userId,
      shared,
      shareCount,
      // Clona o modelo p/ cada parcela ter estado de pagamento próprio.
      shares:
        shared && shares ? (shares.map((s) => ({ ...s })) as Prisma.InputJsonValue) : Prisma.DbNull,
    };
  });
}

export default async function installmentsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const items = await app.prisma.installmentPlan.findMany({
      where: { workspaceId: request.workspace!.id, deletedAt: null },
      include: {
        _count: { select: { transactions: true } },
        tags: { select: { id: true, name: true, color: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { items };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const plan = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      include: {
        transactions: { where: { deletedAt: null }, orderBy: { installmentNumber: 'asc' } },
        tags: { select: { id: true, name: true, color: true } },
      },
    });
    if (!plan) throw NotFound('Parcelamento não encontrado');
    return { plan };
  });

  // Cria o plano + gera as N parcelas (PENDING) — já entram na previsão.
  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = createSchema.parse(request.body);

    const card = await assertOwner(app, request.workspace!.id, body);

    const validTagIds = await validWorkspaceTagIds(app.prisma, request.workspace!.id, body.tagIds);

    const amounts = splitAmount(new Decimal(body.totalAmount), body.installments);

    // Divisão entre pessoas (opcional). O modelo fica no plano; cada parcela
    // recebe um clone com seu próprio estado de pagamento.
    const shares = normalizeShares(body.shares);
    const shared = shares !== null;
    const shareCount = shared ? Math.max(body.shareCount ?? shares.length, shares.length) : null;

    // `firstDueDate` é o vencimento da parcela inicial (startInstallment).
    // A 1ª parcela do plano fica `startInstallment - 1` meses antes.
    const planFirstDue = addMonths(body.firstDueDate, -(body.startInstallment - 1));

    const plan = await app.prisma.$transaction(async (tx) => {
      const created = await tx.installmentPlan.create({
        data: {
          workspaceId: request.workspace!.id,
          clientId: body.clientId ?? null,
          description: body.description,
          totalAmount: body.totalAmount,
          installments: body.installments,
          firstDueDate: planFirstDue,
          categoryId: body.categoryId ?? null,
          shared,
          shareCount,
          shares: shared ? (shares as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      });

      // Cartão: materializa as faturas (futuras) dos ciclos e vincula cada parcela.
      const invoiceByDue = card
        ? await ensureInvoicesForDates(
            tx,
            card,
            pendingDueDates(planFirstDue, body.installments, body.startInstallment),
          )
        : null;

      await tx.transaction.createMany({
        data: buildParcelaRows({
          workspaceId: request.workspace!.id,
          userId: request.userId!,
          planId: created.id,
          body,
          amounts,
          planFirstDue,
          shared,
          shareCount,
          shares,
          invoiceByDue,
        }),
      });

      // Vincula as tags ao plano e propaga a cada parcela (createMany não grava
      // relação N:N — então buscamos as parcelas recém-criadas e conectamos).
      if (validTagIds.length > 0) {
        await tx.installmentPlan.update({
          where: { id: created.id },
          data: { tags: { connect: validTagIds.map((tid) => ({ id: tid })) } },
        });
        const parcelas = await tx.transaction.findMany({
          where: { installmentPlanId: created.id, deletedAt: null },
          select: { id: true },
        });
        await connectTagsToTransactions(
          tx,
          validTagIds,
          parcelas.map((p) => p.id),
        );
      }

      return created;
    });

    return reply.code(201).send({ plan });
  });

  // Edita o plano: atualiza valor/parcelas/datas/conta-cartão/categoria/rateio e
  // regenera o quadro de parcelas. As parcelas atuais são removidas (soft delete)
  // e recriadas; parcelas anteriores à `startInstallment` voltam como quitadas.
  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createSchema.parse(request.body);

    const existing = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw NotFound('Parcelamento não encontrado');

    const card = await assertOwner(app, request.workspace!.id, body);

    const validTagIds = await validWorkspaceTagIds(app.prisma, request.workspace!.id, body.tagIds);

    // Cartão antigo das parcelas atuais (pode mudar nesta edição) — usado p/
    // limpar faturas que ficarem vazias após a regeneração.
    const prevTx = await app.prisma.transaction.findFirst({
      where: { installmentPlanId: id, creditCardId: { not: null }, deletedAt: null },
      select: { creditCardId: true },
    });

    const amounts = splitAmount(new Decimal(body.totalAmount), body.installments);
    const shares = normalizeShares(body.shares);
    const shared = shares !== null;
    const shareCount = shared ? Math.max(body.shareCount ?? shares.length, shares.length) : null;
    const planFirstDue = addMonths(body.firstDueDate, -(body.startInstallment - 1));

    const plan = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.installmentPlan.update({
        where: { id },
        data: {
          description: body.description,
          totalAmount: body.totalAmount,
          installments: body.installments,
          firstDueDate: planFirstDue,
          categoryId: body.categoryId ?? null,
          shared,
          shareCount,
          shares: shared ? (shares as Prisma.InputJsonValue) : Prisma.DbNull,
          // tagIds ausente = não mexe; presente (mesmo vazio) = redefine o conjunto.
          ...(body.tagIds !== undefined
            ? { tags: { set: validTagIds.map((tid) => ({ id: tid })) } }
            : {}),
        },
      });

      // Remove o quadro atual e regenera do zero com os novos parâmetros.
      await tx.transaction.updateMany({
        where: { installmentPlanId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      const invoiceByDue = card
        ? await ensureInvoicesForDates(
            tx,
            card,
            pendingDueDates(planFirstDue, body.installments, body.startInstallment),
          )
        : null;

      await tx.transaction.createMany({
        data: buildParcelaRows({
          workspaceId: request.workspace!.id,
          userId: request.userId!,
          planId: id,
          body,
          amounts,
          planFirstDue,
          shared,
          shareCount,
          shares,
          invoiceByDue,
        }),
      });

      // Reaplica as tags do plano às parcelas regeradas.
      if (validTagIds.length > 0) {
        const parcelas = await tx.transaction.findMany({
          where: { installmentPlanId: id, deletedAt: null },
          select: { id: true },
        });
        await connectTagsToTransactions(
          tx,
          validTagIds,
          parcelas.map((p) => p.id),
        );
      }

      // Faturas que ficaram sem lançamento (cartão removido/trocado/menos parcelas).
      const wsId = request.workspace!.id;
      const cardIds = new Set<string>();
      if (prevTx?.creditCardId) cardIds.add(prevTx.creditCardId);
      if (card?.id) cardIds.add(card.id);
      for (const cardId of cardIds) await pruneEmptyOpenInvoices(tx, wsId, cardId);

      return updated;
    });

    return reply.send({ plan });
  });

  // Troca apenas a categoria do plano e propaga às parcelas — sem regenerar o
  // quadro (preserva pagamentos, datas e faturas). Usado pela alteração em massa.
  app.patch('/:id/category', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { categoryId } = z.object({ categoryId: z.string().nullable() }).parse(request.body);

    const existing = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw NotFound('Parcelamento não encontrado');

    const plan = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.installmentPlan.update({ where: { id }, data: { categoryId } });
      await tx.transaction.updateMany({
        where: { installmentPlanId: id, deletedAt: null },
        data: { categoryId },
      });
      return updated;
    });

    return reply.send({ plan });
  });

  app.delete('/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.installmentPlan.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Parcelamento não encontrado');

    const wsId = request.workspace!.id;
    // Cartões cujas faturas podem esvaziar ao remover as parcelas pendentes.
    const cardTx = await app.prisma.transaction.findMany({
      where: { installmentPlanId: id, status: 'PENDING', creditCardId: { not: null }, deletedAt: null },
      select: { creditCardId: true },
      distinct: ['creditCardId'],
    });

    await app.prisma.$transaction(async (tx) => {
      await tx.installmentPlan.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.transaction.updateMany({
        where: { installmentPlanId: id, status: 'PENDING', deletedAt: null },
        data: { deletedAt: new Date() },
      });
      for (const t of cardTx) {
        if (t.creditCardId) await pruneEmptyOpenInvoices(tx, wsId, t.creditCardId);
      }
    });
    return reply.code(204).send();
  });
}
