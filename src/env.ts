import { z } from 'zod';

/**
 * Validação das variáveis de ambiente. Falha cedo (no boot) se algo essencial
 * faltar — melhor do que descobrir em produção numa request.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // --- Importação por LLM (extratos, comprovantes) ---
  // Provider trocável: hoje "openai"; novos providers entram em src/lib/llm.
  LLM_PROVIDER: z.enum(['openai']).default('openai'),
  // Modelo configurável; precisa suportar visão p/ imagens e leitura de PDF.
  LLM_MODEL: z.string().default('gpt-4o'),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  OPENAI_API_KEY: z.string().optional(),
  // Limite de upload do documento a importar (em MB).
  IMPORT_MAX_FILE_MB: z.coerce.number().int().positive().default(15),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '❌ Variáveis de ambiente inválidas:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

// Validação condicional: a chave da OpenAI só é exigida quando esse é o provider.
if (parsed.data.LLM_PROVIDER === 'openai' && !parsed.data.OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  LLM_PROVIDER=openai mas OPENAI_API_KEY não definida — a importação de documentos por IA vai falhar até configurar.',
  );
}

export const env = parsed.data;
export type Env = typeof env;

/** Lista de origens permitidas para CORS. */
export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
