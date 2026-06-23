import { z } from 'zod';

/**
 * Cada mudança vinda do dispositivo é idempotente por `clientId` (UUID gerado no
 * device). Reenviar a fila nunca duplica (upsert por clientId).
 * Referências (accountId/categoryId) podem ser clientIds de itens criados no
 * MESMO push — o servidor resolve via idMap, na ordem accounts→categories→tx.
 */
const accountData = z.object({
  name: z.string().min(1),
  type: z.enum([
    'CHECKING', 'SAVINGS', 'CASH', 'DEBIT_CARD',
    'MEAL_VOUCHER', 'INVESTMENT', 'LOAN', 'OTHER',
  ]),
  currency: z.string().length(3).default('BRL'),
  iconColor: z.string().nullable().optional(),
  openingBalance: z.coerce.number().optional(),
  includeInTotal: z.boolean().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  institutionId: z.string().nullable().optional(),
});

// Cartão de crédito é entidade própria (não tem saldo): sincroniza limite + ciclo.
const creditCardData = z.object({
  name: z.string().min(1),
  currency: z.string().length(3).default('BRL'),
  iconColor: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  institutionId: z.string().nullable().optional(),
  creditLimit: z.coerce.number().nullable().optional(),
  statementClosingDay: z.number().int().min(1).max(31).nullable().optional(),
  paymentDueDay: z.number().int().min(1).max(31).nullable().optional(),
  lateInterestRate: z.coerce.number().min(0).nullable().optional(),
  // referência a uma conta (pode ser um clientId criado no mesmo push)
  paymentAccountId: z.string().nullable().optional(),
});

const categoryData = z.object({
  name: z.string().min(1),
  kind: z.enum(['INCOME', 'EXPENSE']),
  nature: z.enum(['FIXED', 'VARIABLE', 'LEISURE', 'INVESTMENT', 'INCOME', 'OTHER']).default('VARIABLE'),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
});

export const txShareSchema = z.object({
  name: z.string().min(1).max(80),
  paid: z.boolean().default(false),
  owner: z.boolean().optional(),
  // Vínculo opcional a um membro real do workspace (User.id). Quando presente,
  // a parte cai no painel "Despesas que você deve pagar" desse membro.
  userId: z.string().min(1).nullable().optional(),
});

const transactionData = z.object({
  // Dono: conta OU cartão (resolvidos via idMap). Exatamente um vem preenchido.
  accountId: z.string().min(1).nullable().optional(),
  creditCardId: z.string().min(1).nullable().optional(),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER']),
  status: z.enum(['COMPLETED', 'PENDING', 'CANCELED']).default('COMPLETED'),
  amount: z.coerce.number(),
  currency: z.string().length(3).default('BRL'),
  description: z.string().min(1),
  notes: z.string().nullable().optional(),
  categoryId: z.string().nullable().optional(),
  date: z.coerce.date(),
  dueDate: z.coerce.date().nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
  // Duplicidade e compartilhamento (offline-first: viajam na própria transação).
  duplicateDismissed: z.boolean().optional(),
  shared: z.boolean().optional(),
  shareCount: z.number().int().min(1).nullable().optional(),
  shares: z.array(txShareSchema).nullable().optional(),
  // Tags vinculadas (ids do servidor — tags são geridas online). Ausente = não mexe.
  tagIds: z.array(z.string()).optional(),
});

const change = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    // Normalmente um UUID gerado no device, mas registros nascidos no SERVIDOR
    // (import sem clientId, transferências com sufixo `:out`/`:in`) viajam com o
    // próprio id/cuid como clientId quando editados offline. Aceita qualquer
    // string não-vazia; o push resolve o registro por clientId OU id.
    clientId: z.string().min(1),
    deleted: z.boolean().optional(),
    data: data.optional(), // ausente quando deleted=true
  });

export const pushSchema = z.object({
  accounts: z.array(change(accountData)).default([]),
  creditCards: z.array(change(creditCardData)).default([]),
  categories: z.array(change(categoryData)).default([]),
  transactions: z.array(change(transactionData)).default([]),
});

export const pullSchema = z.object({
  since: z.coerce.date().optional(),
});

export type AccountChange = z.infer<ReturnType<typeof change<typeof accountData>>>;
export type CreditCardChange = z.infer<ReturnType<typeof change<typeof creditCardData>>>;
export type CategoryChange = z.infer<ReturnType<typeof change<typeof categoryData>>>;
export type TransactionChange = z.infer<ReturnType<typeof change<typeof transactionData>>>;
