import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { Decimal } from '../../lib/money';
import { creditCardAvailable, workspaceCardsUsed } from '../../lib/balance';
import { logActivity } from '../../lib/activity';

// Cartão de crédito é entidade SEPARADA de conta (não tem saldo): só limite +
// fatura. Os campos bancários (agência, LIS, etc.) NÃO existem aqui.
const baseSchema = z.object({
  name: z.string().min(1).max(120),
  currency: z.string().length(3).default('BRL'),
  institutionId: z.string().nullable().optional(),
  iconColor: z.string().max(20).optional(),
  sortOrder: z.number().int().optional(),
  clientId: z.string().uuid().optional(),
  creditLimit: z.coerce.number().min(0).optional(),
  statementClosingDay: z.number().int().min(1).max(31).optional(),
  paymentDueDay: z.number().int().min(1).max(31).optional(),
  lateInterestRate: z.coerce.number().min(0).optional(),
  paymentAccountId: z.string().nullable().optional(),
});

const updateSchema = baseSchema.partial().extend({ archived: z.boolean().optional() });

export default async function cardsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const { includeArchived } = request.query as { includeArchived?: string };
    const cards = await app.prisma.creditCard.findMany({
      where: {
        workspaceId: request.workspace!.id,
        deletedAt: null,
        ...(includeArchived === 'true' ? {} : { archived: false }),
      },
      include: { institution: { select: { id: true, name: true, brandColor: true, logoUrl: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const used = await workspaceCardsUsed(app.prisma, request.workspace!.id);

    const withAvailable = cards.map((c) => ({
      ...c,
      creditAvailable:
        c.creditLimit == null
          ? null
          : new Decimal(c.creditLimit).minus(used.get(c.id) ?? new Decimal(0)),
    }));

    return { cards: withAvailable };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const card = await app.prisma.creditCard.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
      include: { institution: true },
    });
    if (!card) throw NotFound('Cartão não encontrado');

    return {
      card: { ...card, creditAvailable: await creditCardAvailable(app.prisma, card) },
    };
  });

  app.post('/', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = baseSchema.parse(request.body);
    const card = await app.prisma.creditCard.create({
      data: { ...body, workspaceId: request.workspace!.id },
    });
    await logActivity(app.prisma, {
      workspaceId: request.workspace!.id,
      actorId: request.userId,
      action: 'card.created',
      entityType: 'CreditCard',
      entityId: card.id,
      metadata: { name: card.name },
    });
    return reply.code(201).send({ card });
  });

  app.patch('/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.creditCard.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Cartão não encontrado');

    const body = updateSchema.parse(request.body);
    const card = await app.prisma.creditCard.update({ where: { id }, data: body });
    return { card };
  });

  app.delete('/:id', { preHandler: [requireRole('ADMIN')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.creditCard.findFirst({
      where: { id, workspaceId: request.workspace!.id, deletedAt: null },
    });
    if (!existing) throw NotFound('Cartão não encontrado');

    await app.prisma.creditCard.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });
}
