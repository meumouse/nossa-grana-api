import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../../lib/errors';
import { requireRole } from '../../plugins/workspace';
import { Decimal } from '../../lib/money';
import { assetWithPosition, computePosition } from './investments.service';

const assetSchema = z.object({
  symbol: z.string().max(20).nullable().optional(),
  name: z.string().min(1).max(120),
  class: z.enum(['STOCK', 'FII', 'ETF', 'FUND', 'FIXED_INCOME', 'CRYPTO', 'OTHER']),
  currency: z.string().length(3).default('BRL'),
  lastPrice: z.coerce.number().nonnegative().nullable().optional(),
});

const txSchema = z.object({
  clientId: z.string().uuid().optional(),
  accountId: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.enum(['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'CONTRIBUTION', 'WITHDRAWAL']),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
  fees: z.coerce.number().nonnegative().default(0),
  date: z.coerce.date(),
});

export default async function investmentsRoutes(app: FastifyInstance): Promise<void> {
  // Lista ativos com posição derivada.
  app.get('/assets', async (request) => {
    const assets = await app.prisma.investmentAsset.findMany({
      where: { workspaceId: request.workspace!.id },
      include: { transactions: { where: { deletedAt: null } } },
      orderBy: { name: 'asc' },
    });

    const result = assets.map((a) => {
      const { transactions, ...asset } = a;
      return {
        ...asset,
        position: computePosition(transactions, a.lastPrice ? new Decimal(a.lastPrice) : null),
      };
    });
    return { assets: result };
  });

  app.get('/assets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const data = await assetWithPosition(app.prisma, id);
    if (!data || data.asset.workspaceId !== request.workspace!.id) throw NotFound('Ativo não encontrado');
    return data;
  });

  app.post('/assets', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = assetSchema.parse(request.body);
    const asset = await app.prisma.investmentAsset.create({
      data: {
        workspaceId: request.workspace!.id,
        symbol: body.symbol ?? null,
        name: body.name,
        class: body.class,
        currency: body.currency,
        lastPrice: body.lastPrice ?? null,
        lastPriceAt: body.lastPrice != null ? new Date() : null,
      },
    });
    return reply.code(201).send({ asset });
  });

  app.patch('/assets/:id', { preHandler: [requireRole('MEMBER')] }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.investmentAsset.findFirst({
      where: { id, workspaceId: request.workspace!.id },
    });
    if (!existing) throw NotFound('Ativo não encontrado');
    const body = assetSchema.partial().parse(request.body);
    const asset = await app.prisma.investmentAsset.update({
      where: { id },
      data: {
        ...body,
        ...(body.lastPrice !== undefined ? { lastPriceAt: new Date() } : {}),
      },
    });
    return { asset };
  });

  /**
   * Exclui um ativo. Hard delete: os movimentos do ativo são removidos junto
   * (InvestmentTransaction.assetId tem onDelete: Cascade). A posição é derivada
   * dos movimentos, então não sobra estado órfão.
   */
  app.delete('/assets/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.investmentAsset.findFirst({
      where: { id, workspaceId: request.workspace!.id },
      select: { id: true },
    });
    if (!existing) throw NotFound('Ativo não encontrado');

    await app.prisma.investmentAsset.delete({ where: { id } });
    return reply.code(204).send();
  });

  // Movimentos do ativo.
  app.post('/transactions', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const body = txSchema.parse(request.body);

    const [account, asset] = await Promise.all([
      app.prisma.account.findFirst({
        where: { id: body.accountId, workspaceId: request.workspace!.id, deletedAt: null },
        select: { id: true },
      }),
      app.prisma.investmentAsset.findFirst({
        where: { id: body.assetId, workspaceId: request.workspace!.id },
        select: { id: true },
      }),
    ]);
    if (!account) throw BadRequest('Conta inválida para este workspace');
    if (!asset) throw BadRequest('Ativo inválido para este workspace');

    const tx = await app.prisma.investmentTransaction.create({
      data: {
        clientId: body.clientId ?? null,
        accountId: body.accountId,
        assetId: body.assetId,
        kind: body.kind,
        quantity: body.quantity,
        unitPrice: body.unitPrice,
        fees: body.fees,
        date: body.date,
      },
    });
    return reply.code(201).send({ transaction: tx });
  });

  app.delete('/transactions/:id', { preHandler: [requireRole('MEMBER')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await app.prisma.investmentTransaction.findFirst({
      where: { id, asset: { workspaceId: request.workspace!.id } },
    });
    if (!existing) throw NotFound('Movimento não encontrado');
    await app.prisma.investmentTransaction.update({ where: { id }, data: { deletedAt: new Date() } });
    return reply.code(204).send();
  });
}
