import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDefaultCategories } from '../../lib/defaults';

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['PERSONAL', 'SHARED']).default('SHARED'),
  iconColor: z.string().max(20).optional(),
});

/** Rotas de workspace NÃO escopadas (listar os meus / criar). */
export default async function workspacesTopRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // Lista os workspaces de que o usuário participa.
  app.get('/', async (request) => {
    const memberships = await app.prisma.member.findMany({
      where: { userId: request.userId!, deletedAt: null, workspace: { deletedAt: null } },
      select: {
        role: true,
        displayName: true,
        workspace: {
          select: { id: true, name: true, type: true, iconColor: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      workspaces: memberships.map((m) => ({
        ...m.workspace,
        role: m.role,
        displayName: m.displayName,
      })),
    };
  });

  // Cria um novo workspace (o criador vira OWNER) com settings e categorias padrão.
  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);

    const workspace = await app.prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.create({
        data: {
          name: body.name,
          type: body.type,
          iconColor: body.iconColor ?? null,
          members: { create: { userId: request.userId!, role: 'OWNER' } },
          settings: { create: {} },
        },
      });
      await createDefaultCategories(tx, ws.id);
      return ws;
    });

    return reply.code(201).send({ workspace });
  });
}
