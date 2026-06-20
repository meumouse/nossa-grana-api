import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Registra um evento no feed de atividade (transparência no modo família). */
export async function logActivity(
  db: Db,
  input: {
    workspaceId: string;
    actorId?: string | null;
    action: string; // ex.: "transaction.created"
    entityType: string;
    entityId: string;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.activityLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata,
    },
  });
}
