import { z } from 'zod';

/** Edição/decisão de um item na tela de revisão. */
export const patchItemSchema = z.object({
  date: z.coerce.date().optional(),
  description: z.string().min(1).max(200).optional(),
  amount: z.coerce.number().positive().optional(),
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional(),
});

/** Confirmação do lote: cria as transações dos itens ACCEPTED. */
export const confirmSchema = z.object({
  // conta usada para itens que ficaram sem conta definida na revisão
  defaultAccountId: z.string().optional(),
});

export const listQuerySchema = z.object({
  status: z
    .enum(['PROCESSING', 'PENDING_REVIEW', 'IMPORTING', 'CONFIRMED', 'CANCELED', 'FAILED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
