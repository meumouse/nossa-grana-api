import { hash, verify } from '@node-rs/argon2';

// Parâmetros recomendados (OWASP) para argon2id.
const OPTS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, OPTS);
  } catch {
    return false;
  }
}
