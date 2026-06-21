import { z } from 'zod';

export const createTxSchema = z.object({
  clientId: z.string().uuid().optional(),
  accountId: z.string().min(1),
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

export const updateTxSchema = createTxSchema
  .partial()
  .omit({ clientId: true })
  .extend({ type: z.enum(['INCOME', 'EXPENSE']).optional() });

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
  categoryId: z.string().optional(),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER']).optional(),
  status: z.enum(['COMPLETED', 'PENDING', 'CANCELED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
