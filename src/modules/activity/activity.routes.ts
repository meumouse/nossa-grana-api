import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const q = z
      .object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(request.query);

    const items = await app.prisma.activityLog.findMany({
      where: { workspaceId: request.workspace!.id },
      include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > q.limit;
    const page = hasMore ? items.slice(0, q.limit) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null };
  });
}
