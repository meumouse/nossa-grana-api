import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Token opaco de alta entropia (refresh token, convite). */
export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('hex');
}

/** Hash determinístico p/ guardar tokens no banco sem armazenar o valor cru. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { randomUUID };
