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

  // --- Cache ---
  // Sem REDIS_URL, o cache roda EM MEMÓRIA (in-process): zero infra, ótimo p/
  // dados quentes (ex.: associação do usuário ao workspace). Definindo a URL
  // (ex.: redis://localhost:6379), passa a usar Redis — cache compartilhado
  // entre instâncias e persistente entre restarts. Requer a dep `ioredis`.
  REDIS_URL: z.string().optional(),
  // Teto de entradas do cache em memória (evicção por idade ao estourar).
  CACHE_MAX_MEMORY_ENTRIES: z.coerce.number().int().positive().default(5000),
  // TTL padrão (s) quando o set não informa um — fallback de segurança.
  CACHE_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  // TTL (s) da associação usuário↔workspace (lida em toda request escopada).
  // Curto de propósito: mudanças de papel/remoção também invalidam na hora.
  CACHE_TTL_MEMBER_SECONDS: z.coerce.number().int().positive().default(30),
  // TTL (s) do catálogo de instituições (dado quase estático).
  CACHE_TTL_INSTITUTIONS_SECONDS: z.coerce.number().int().positive().default(300),
  // TTL (s) do cache da extração com IA por documento (hash do conteúdo +
  // provider/modelo). 7 dias: reaproveita o processamento de um documento já
  // lido — mesmo que o lote seja descartado/cancelado ou o doc seja reenviado —
  // sem repagar tokens. Best-effort (persiste de verdade só com Redis).
  EXTRACTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),

  JWT_ACCESS_SECRET: z.string().min(24),
  JWT_REFRESH_SECRET: z.string().min(24),
  // Chave p/ cifrar segredos guardados no banco (ex.: chave de LLM por
  // workspace). Se ausente, deriva-se do segredo de refresh (ver lib/secrets).
  SETTINGS_ENCRYPTION_KEY: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // --- Login com Google (Google Identity Services) ---
  // Client ID OAuth do Google Cloud (tipo "Web application"). OPCIONAL: sem ele
  // o login com Google fica desativado e o app segue só com e-mail/senha. É o
  // mesmo valor usado no PWA (VITE_GOOGLE_CLIENT_ID) — o backend só o usa como
  // `audience` ao validar o ID token, então NÃO precisa do client secret.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),

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
  // Provider trocável (default global; cada workspace pode sobrescrever).
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'google']).default('openai'),
  // Modelo default p/ o provider de env; precisa suportar visão (imagem/PDF).
  LLM_MODEL: z.string().default('gpt-4o'),
  // Saída máxima do modelo. 4096 trunca o JSON em extratos/faturas pesados
  // (muitas transações) → resposta cortada e falha de parse. 8192 cobre a maioria
  // dos documentos; aumente (ex.: 16384/32768 nos modelos gpt-4.1) p/ docs grandes.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  // Fracionamento de PDFs grandes: páginas por chunk enviado à IA. Documentos
  // grandes em uma única chamada são lidos com menos precisão (e a resposta pode
  // truncar); quebrar por páginas melhora a leitura. 0 = desliga (chamada única).
  LLM_PDF_CHUNK_PAGES: z.coerce.number().int().min(0).default(4),
  // Chunks processados em paralelo (cuidado com rate limit do provider).
  LLM_CHUNK_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Categorização de CSV/OFX: linhas por lote enviado à IA. 0 = sem fracionar.
  LLM_CSV_CHUNK_ROWS: z.coerce.number().int().min(0).default(200),
  // Chaves de API por provider (fallback global; o workspace pode definir a sua).
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
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

// Validação condicional: a chave do provider default só é exigida quando ele é
// o provider em uso (o workspace pode configurar a sua própria chave depois).
{
  const keyByProvider = {
    openai: parsed.data.OPENAI_API_KEY,
    anthropic: parsed.data.ANTHROPIC_API_KEY,
    google: parsed.data.GOOGLE_API_KEY,
  } as const;
  const envName = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  } as const;
  const provider = parsed.data.LLM_PROVIDER;
  if (!keyByProvider[provider]) {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  LLM_PROVIDER=${provider} mas ${envName[provider]} não definida — a importação por IA vai falhar até configurar (no env ou nas Configurações do workspace).`,
    );
  }
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

/**
 * Fila de jobs (BullMQ) habilitada somente quando há Redis configurado. Sem
 * Redis, a confirmação de importação roda inline no request (modo legado).
 */
export const queueEnabled = Boolean(env.REDIS_URL);

/** Envio de e-mail habilitado somente quando a chave do Resend está configurada. */
export const emailEnabled = Boolean(env.RESEND_API_KEY);

/** Login com Google habilitado somente quando o Client ID está configurado. */
export const googleAuthEnabled = Boolean(env.GOOGLE_OAUTH_CLIENT_ID);

/** Lista de origens permitidas para CORS. */
export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
