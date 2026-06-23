import { z } from 'zod';

// Dono do lançamento: EXATAMENTE UM entre accountId (conta) e creditCardId
// (cartão). Compra no cartão usa creditCardId.
const createTxBase = z.object({
  clientId: z.string().uuid().optional(),
  accountId: z.string().min(1).optional(),
  creditCardId: z.string().min(1).optional(),
  type: z.enum(['INCOME', 'EXPENSE']), // TRANSFER tem endpoint próprio
  status: z.enum(['COMPLETED', 'PENDING', 'CANCELED']).default('COMPLETED'),
  amount: z.coerce.number().positive('O valor deve ser maior que zero'),
  currency: z.string().length(3).default('BRL'),
  description: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  categoryId: z.string().nullable().optional(),
  date: z.coerce.date(),
  dueDate: z.coerce.date().nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
  creditCardInvoiceId: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
});

const exactlyOneOwner = (b: { accountId?: string; creditCardId?: string }) =>
  (b.accountId ? 1 : 0) + (b.creditCardId ? 1 : 0) === 1;

export const createTxSchema = createTxBase.refine(exactlyOneOwner, {
  message: 'Informe exatamente um entre accountId e creditCardId',
  path: ['accountId'],
});

export const updateTxSchema = createTxBase
  .partial()
  .omit({ clientId: true })
  .extend({ type: z.enum(['INCOME', 'EXPENSE']).optional() })
  // No update, se vier um dono, não pode vir os dois ao mesmo tempo.
  .refine((b) => !(b.accountId && b.creditCardId), {
    message: 'Informe apenas um entre accountId e creditCardId',
    path: ['accountId'],
  });

export const transferSchema = z.object({
  clientId: z.string().uuid().optional(),
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  amount: z.coerce.number().positive(),
  description: z.string().min(1).max(200).default('Transferência'),
  notes: z.string().max(2000).optional(),
  date: z.coerce.date(),
  status: z.enum(['COMPLETED', 'PENDING']).default('COMPLETED'),
});

export const paySchema = z.object({
  paidAt: z.coerce.date().optional(),
});

export const analyzeSchema = z.object({
  checks: z
    .array(z.enum(['DUPLICATE', 'CATEGORY', 'AMOUNT']))
    .min(1)
    .default(['DUPLICATE', 'CATEGORY', 'AMOUNT']),
  transactions: z
    .array(
      z.object({
        index: z.number().int().min(0),
        date: z.string().min(1),
        description: z.string().min(1).max(200),
        amount: z.coerce.number(),
        type: z.enum(['INCOME', 'EXPENSE']),
        category: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const listQuerySchema = z.object({
  accountId: z.string().optional(),
  creditCardId: z.string().optional(),
  categoryId: z.string().optional(),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER']).optional(),
  status: z.enum(['COMPLETED', 'PENDING', 'CANCELED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().optional(),
  // Filtro por tag (OR). Aceita repetição (?tagIds=a&tagIds=b) ou CSV (?tagIds=a,b).
  tagIds: z
    .preprocess((v) => {
      if (v == null) return undefined;
      const arr = Array.isArray(v) ? v : String(v).split(',');
      return arr.map((s) => String(s).trim()).filter(Boolean);
    }, z.array(z.string()))
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
