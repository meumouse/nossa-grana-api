import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** Categorias padrão criadas junto com um novo workspace. */
const DEFAULT_CATEGORIES: Array<{
  name: string;
  kind: 'INCOME' | 'EXPENSE';
  nature: 'FIXED' | 'VARIABLE' | 'LEISURE' | 'INVESTMENT' | 'INCOME' | 'OTHER';
  icon?: string;
  color?: string;
}> = [
  // Receitas
  { name: 'Salário', kind: 'INCOME', nature: 'INCOME', icon: '💼', color: '#16a34a' },
  { name: 'Renda extra', kind: 'INCOME', nature: 'INCOME', icon: '➕', color: '#22c55e' },
  // Despesas fixas
  { name: 'Moradia', kind: 'EXPENSE', nature: 'FIXED', icon: '🏠', color: '#ef4444' },
  { name: 'Contas & assinaturas', kind: 'EXPENSE', nature: 'FIXED', icon: '🧾', color: '#f97316' },
  { name: 'Educação', kind: 'EXPENSE', nature: 'FIXED', icon: '📚', color: '#eab308' },
  // Despesas variáveis
  { name: 'Mercado', kind: 'EXPENSE', nature: 'VARIABLE', icon: '🛒', color: '#3b82f6' },
  { name: 'Transporte', kind: 'EXPENSE', nature: 'VARIABLE', icon: '🚗', color: '#6366f1' },
  { name: 'Saúde', kind: 'EXPENSE', nature: 'VARIABLE', icon: '⚕️', color: '#06b6d4' },
  // Lazer
  { name: 'Lazer', kind: 'EXPENSE', nature: 'LEISURE', icon: '🎉', color: '#ec4899' },
  { name: 'Restaurantes', kind: 'EXPENSE', nature: 'LEISURE', icon: '🍔', color: '#d946ef' },
  // Investimento
  { name: 'Investimentos', kind: 'EXPENSE', nature: 'INVESTMENT', icon: '📈', color: '#10b981' },
  // Outros
  { name: 'Outros', kind: 'EXPENSE', nature: 'OTHER', icon: '📦', color: '#64748b' },
];

export async function createDefaultCategories(db: Db, workspaceId: string): Promise<void> {
  await db.category.createMany({
    data: DEFAULT_CATEGORIES.map((c, i) => ({ ...c, workspaceId, sortOrder: i })),
  });
}
