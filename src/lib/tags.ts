import type { Prisma } from '@prisma/client';

/**
 * Cliente Prisma aceito pelos helpers — tanto o cliente normal quanto o de uma
 * transação interativa (`$transaction(async (tx) => …)`).
 */
type Db = Prisma.TransactionClient;

/**
 * Filtra os ids informados para apenas as tags que pertencem ao workspace. Ids
 * inválidos/órfãos são ignorados (não quebram a operação). Devolve a lista
 * saneada — vazia quando nada foi informado.
 */
export async function validWorkspaceTagIds(
  db: Db,
  workspaceId: string,
  tagIds: string[] | undefined | null,
): Promise<string[]> {
  if (!tagIds || tagIds.length === 0) return [];
  const found = await db.tag.findMany({
    where: { id: { in: tagIds }, workspaceId },
    select: { id: true },
  });
  return found.map((t) => t.id);
}

/**
 * Vincula um conjunto de tags a várias transações de uma vez (relação N:N). O
 * `connect` é idempotente, então reconectar uma tag já presente é inofensivo —
 * por isso podemos chamar com segurança em materializações repetidas.
 */
export async function connectTagsToTransactions(
  db: Db,
  tagIds: string[],
  txIds: string[],
): Promise<void> {
  if (tagIds.length === 0 || txIds.length === 0) return;
  const connect = txIds.map((id) => ({ id }));
  // Uma atualização por tag (em vez de por transação) — barato mesmo com muitas
  // parcelas, pois o nº de tags costuma ser pequeno.
  for (const tagId of tagIds) {
    await db.tag.update({ where: { id: tagId }, data: { transactions: { connect } } });
  }
}
