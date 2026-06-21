import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { accountBalance, creditCardAvailable, workspaceBalances } from '../../lib/balance';
import { logActivity } from '../../lib/activity';

const baseSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum([
    'CHECKING',
    'SAVINGS',
    'CASH',
    'CREDIT_CARD',
    'DEBIT_CARD',
    'MEAL_VOUCHER',
    'INVESTMENT',
    'LOAN',
    'OTHER',
  ]),
  currency: z.string().length(3).default('BRL'),
  institutionId: z.string().nullable().optional(),
  iconColor: z.string().max(20).optional(),
  openingBalance: z.coerce.number().optional(),
  includeInTotal: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  clientId: z.string().uuid().optional(),
  // Cartão de crédito
  creditLimit: z.coerce.number().optional(),
  statementClosingDay: z.number().int().min(1).max(31).optional(),
  paymentDueDay: z.number().int().min(1).max(31).optional(),
  lateInterestRate: z.coerce.number().min(0).optional(),
  paymentAccountId: z.string().optional(),
  // Conta bancária (dados + LIS / cheque especial)
  agency: z.string().max(20).nullable().optional(),
  accountNumber: z.string().max(30).nullable().optional(),
  accountDigit: z.string().max(5).nullable().optional(),
  overdraftLimit: z.coerce.number().min(0).optional(),
  overdraftInterestRate: z.coerce.number().min(0).optional(),
  // Financiamento
  loanPrincipal: z.coerce.number().optional(),
  loanInstallments: z.number().int().positive().optional(),
  loanInterestRate: z.coerce.number().optional(),
  loanStartDate: z.coerce.date().optional(),
});

const updateSchema = baseSchema.partial().extend({ archived: z.boolean().optional() });

export default async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const { includeArchived } = request.query as { includeArchived?: string };
    const accounts = await app.prisma.account.findMany({
      where: {
        workspaceId: request.workspace!.id,
        deletedAt: null,
        ...(includeArchived === 'true' ? {} : { archived: false }),
      },
      include: { institution: { select: { id: true, name: true, brandColor: true, logoUrl: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const balances = await workspaceBalances(app.prisma, request.workspace!.id);

    const withBalances = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        balance: balances.get(a.id) ?? a.openingBalance,
        creditAvailable:
          a.type === 'CREDIT_CARD' ? await creditCardAvailable(app.prisma, a) : null,
      })),
    );

    return { accounts: withBalances };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const account = await app.prisma.account.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      include: { institution: true },
    });
    if (!account) throw NotFound('Conta não encontrada');

    return {
      account: {
        ...account,
        balance: await accountBalance(app.prisma, account.id),
        creditAvailable:
          account.type === 'CREDIT_CARD' ? await creditCardAvailable(app.prisma, account) : null,
      },
    };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = baseSchema.parse(request.body);
    const account = await app.prisma.account.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    await logActivity(app.prisma, {
      workspaceId: request.workspace!.id,
      actorId: request.userId,
      action: 'account.created',
      entityType: 'Account',
      entityId: account.id,
      metadata: { name: account.name, type: account.type },
    });
    return reply.code(201).send({ account });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.account.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Conta não encontrada');

    const body = updateSchema.parse(request.body);
    const account = await app.prisma.account.update({ where: { id }, data: body });
    return { account };
  });

  app.delete('/:id', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.account.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Conta não encontrada');

    await app.prisma.account.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });
}
