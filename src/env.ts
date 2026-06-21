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
  // Nível do logger HTTP (Pino). Use 'debug'/'trace' para investigar, 'warn'
  // para reduzir ruído em produção, 'silent' para desligar.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  // Chave p/ cifrar segredos guardados no banco (ex.: chave de LLM por
  // workspace). Se ausente, deriva-se do segredo de refresh (ver lib/secrets).
  SETTINGS_ENCRYPTION_KEY: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // --- E-mail transacional (Resend) ---
  // URL pública do PWA — base dos links enviados por e-mail (reset, verificação).
  APP_URL: z.string().url().default('http://localhost:5173'),
  // Chave da API do Resend (https://resend.com/api-keys). OPCIONAL: sem ela os
  // e-mails transacionais (recuperação de senha, verificação, boas-vindas) são
  // apenas logados e pulados — o app funciona normalmente, só não envia e-mail.
  RESEND_API_KEY: z.string().optional(),
  // Remetente no formato "Nome <endereco@dominio>". O domínio precisa estar
  // verificado no Resend (ou use o sandbox onboarding@resend.dev em testes).
  RESEND_FROM: z.string().min(1).default('Nossa Grana <onboarding@resend.dev>'),
  // Janela de validade dos tokens enviados por e-mail.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),

  // --- Importação por LLM (extratos, comprovantes) ---
  // Provider trocável: hoje "openai"; novos providers entram em src/lib/llm.
  LLM_PROVIDER: z.enum(['openai']).default('openai'),
  // Modelo configurável; precisa suportar visão p/ imagens e leitura de PDF.
  LLM_MODEL: z.string().default('gpt-4o'),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
  OPENAI_API_KEY: z.string().optional(),
  // Limite de upload do documento a importar (em MB).
  IMPORT_MAX_FILE_MB: z.coerce.number().int().positive().default(15),

  // --- Object storage (S3-compatível: AWS S3, Cloudflare R2, MinIO) ---
  // O storage é opcional: sem S3_BUCKET, os recursos de anexo/persistência de
  // documentos ficam desligados e a API segue funcionando (a importação por IA
  // continua processando o arquivo em memória, só não o guarda).
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Endpoint custom p/ provedores compatíveis (R2/MinIO). Vazio = AWS S3.
  S3_ENDPOINT: z.string().url().optional(),
  // MinIO e afins precisam de path-style (bucket no path, não no host).
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Validade (segundos) das URLs assinadas de download/upload.
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
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

// E-mail: sem chave do Resend, os envios são pulados (não é erro fatal).
if (!parsed.data.RESEND_API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  RESEND_API_KEY não definida — e-mails transacionais (recuperação de senha, verificação, boas-vindas) ficam desativados.',
  );
}

// Storage: se o bucket foi definido, as credenciais precisam acompanhar.
if (
  parsed.data.S3_BUCKET &&
  (!parsed.data.S3_ACCESS_KEY_ID || !parsed.data.S3_SECRET_ACCESS_KEY)
) {
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  S3_BUCKET definido mas S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY ausentes — o storage de anexos/documentos vai falhar até configurar as credenciais.',
  );
}

export const env = parsed.data;
export type Env = typeof env;

/** Storage habilitado somente quando o bucket está configurado. */
export const storageEnabled = Boolean(env.S3_BUCKET);

/** Envio de e-mail habilitado somente quando a chave do Resend está configurada. */
export const emailEnabled = Boolean(env.RESEND_API_KEY);

/** Lista de origens permitidas para CORS. */
export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
