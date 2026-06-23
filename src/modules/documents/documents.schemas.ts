import { z } from 'zod';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Dono opcional do lançamento ao (re)importar um documento com IA. */
export const importSchema = z.object({
  accountId: z.string().optional(),
  creditCardId: z.string().optional(),
});
