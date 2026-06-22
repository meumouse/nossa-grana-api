import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, storageEnabled } from '../env';
import { randomUUID } from './tokens';

/**
 * Abstração de object storage (S3-compatível: AWS S3, Cloudflare R2, MinIO).
 *
 * O storage é opcional — quando `S3_BUCKET` não está configurado, `isEnabled`
 * é false e os módulos que dependem dele degradam graciosamente (a importação
 * por IA segue processando o arquivo em memória, só não o persiste).
 *
 * Guardamos apenas a *chave* do objeto no banco; URLs de download são geradas
 * sob demanda e assinadas, com validade curta (`S3_PRESIGN_TTL_SECONDS`).
 */

let client: S3Client | null = null;

/** Cliente S3 lazy-singleton. Lança se o storage não estiver configurado. */
function getClient(): S3Client {
  if (!storageEnabled) {
    throw new Error('Storage não configurado (defina S3_BUCKET e credenciais).');
  }
  if (!client) {
    client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  return client;
}

export const isStorageEnabled = storageEnabled;

/** Remove caracteres problemáticos de um nome de arquivo p/ compor a chave. */
function sanitizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'arquivo';
}

/**
 * Monta uma chave determinística e isolada por workspace:
 *   `workspaces/{workspaceId}/{prefix}/{ownerId}/{uuid}-{nome}`
 * O prefixo de UUID evita colisão entre uploads do mesmo nome.
 */
export function buildKey(parts: {
  workspaceId: string;
  prefix: 'imports' | 'attachments';
  ownerId: string;
  filename: string;
}): string {
  const safe = sanitizeName(parts.filename);
  return `workspaces/${parts.workspaceId}/${parts.prefix}/${parts.ownerId}/${randomUUID()}-${safe}`;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType?: string;
}

/** Sobe um objeto. Lança se o storage não estiver habilitado. */
export async function putObject(input: PutObjectInput): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
}

/**
 * Baixa um objeto inteiro em memória (Buffer). É como o worker de extração relê
 * o documento original persistido no upload. Lança se o storage estiver
 * desligado ou o objeto não existir.
 */
export async function getObject(key: string): Promise<Buffer> {
  const response = await getClient().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  const body = response.Body;
  if (!body) throw new Error(`Objeto vazio ou inexistente: ${key}`);
  // O Body do SDK v3 (Node) é um Readable; transformToByteArray cobre stream e
  // blob de forma portável entre runtimes.
  const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

/** Remove um objeto. Best-effort: não lança se o objeto já não existe. */
export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
}

/**
 * Gera uma URL assinada de download (GET), válida por `S3_PRESIGN_TTL_SECONDS`.
 * `downloadFilename`, se passado, força o nome no Content-Disposition.
 */
export async function getDownloadUrl(
  key: string,
  downloadFilename?: string,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ...(downloadFilename
      ? {
          ResponseContentDisposition: `attachment; filename="${sanitizeName(downloadFilename)}"`,
        }
      : {}),
  });
  return getSignedUrl(getClient(), command, { expiresIn: env.S3_PRESIGN_TTL_SECONDS });
}

/**
 * Gera uma URL assinada de upload (PUT) p/ envio direto do cliente ao storage,
 * sem passar o arquivo pela API. O cliente faz `PUT url` com o mesmo
 * Content-Type informado aqui.
 */
export async function getUploadUrl(input: {
  key: string;
  contentType?: string;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
  });
  return getSignedUrl(getClient(), command, { expiresIn: env.S3_PRESIGN_TTL_SECONDS });
}
