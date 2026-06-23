import { z } from 'zod';

/** Edição/decisão de um item na tela de revisão. */
export const patchItemSchema = z.object({
  date: z.coerce.date().optional(),
  description: z.string().min(1).max(200).optional(),
  amount: z.coerce.number().positive().optional(),
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  creditCardId: z.string().nullable().optional(),
  status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional(),
});

/**
 * Item revisado enviado no payload de confirmação. Carrega o estado final da
 * tela de revisão num único request (em vez de um PATCH por item).
 */
export const reviewedItemSchema = z.object({
  id: z.string(),
  date: z.coerce.date(),
  description: z.string().min(1).max(200),
  amount: z.coerce.number().positive(),
  type: z.enum(['INCOME', 'EXPENSE']),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  creditCardId: z.string().nullable().optional(),
});

/** Confirmação do lote: cria as transações dos itens ACCEPTED. */
export const confirmSchema = z.object({
  // conta ou cartão usado para itens que ficaram sem dono definido na revisão
  defaultAccountId: z.string().optional(),
  defaultCreditCardId: z.string().optional(),
  // Itens revisados num único payload (substitui os N PATCH por item da tela de
  // revisão). Quando presente: estes viram ACCEPTED com os valores enviados e os
  // demais itens do lote viram REJECTED. Ausente = modo legado (usa o que já foi
  // marcado ACCEPTED por PATCHes anteriores).
  items: z.array(reviewedItemSchema).max(5000).optional(),
});

export const listQuerySchema = z.object({
  status: z
    .enum(['PROCESSING', 'PENDING_REVIEW', 'IMPORTING', 'CONFIRMED', 'CANCELED', 'FAILED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
