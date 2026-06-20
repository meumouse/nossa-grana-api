import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env';

/**
 * Cifragem simétrica para segredos guardados no banco (ex.: chave de API do
 * provider de LLM por workspace). AES-256-GCM com IV aleatório por valor; o
 * formato persistido é `iv:authTag:ciphertext` em hex.
 *
 * A chave deriva (scrypt) de `SETTINGS_ENCRYPTION_KEY` ou, na ausência dela,
 * do segredo de refresh do JWT — assim funciona out-of-the-box em dev e pode
 * ser endurecido em produção definindo a env dedicada.
 */
const KEY = scryptSync(env.SETTINGS_ENCRYPTION_KEY ?? env.JWT_REFRESH_SECRET, 'nossa-grana:secrets', 32);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/** Devolve o texto puro, ou null se o valor estiver vazio/corrompido. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}
