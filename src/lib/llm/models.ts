import { BadRequest } from '../errors';
import type { LlmModelInfo, LlmProvider } from './types';

/**
 * Busca os modelos disponíveis num provider via API, usando a chave informada.
 * Cada provider tem seu endpoint de catálogo; normalizamos para `LlmModelInfo`.
 * Aplicamos um filtro mínimo para esconder modelos que não servem para
 * chat/visão (embeddings, áudio, imagem), evitando poluir o seletor.
 */
export async function listProviderModels(
  provider: LlmProvider,
  apiKey: string,
): Promise<LlmModelInfo[]> {
  switch (provider) {
    case 'openai':
      return listOpenAiModels(apiKey);
    case 'anthropic':
      return listAnthropicModels(apiKey);
    case 'google':
      return listGoogleModels(apiKey);
    default:
      throw BadRequest(`Provider de LLM não suportado: ${provider as string}`);
  }
}

/** Famílias da OpenAI que não são modelos de chat/visão — escondidas do seletor. */
const OPENAI_NON_CHAT =
  /(embedding|whisper|tts|audio|realtime|transcribe|dall-e|image|moderation|search|davinci|babbage|codex)/i;

async function listOpenAiModels(apiKey: string): Promise<LlmModelInfo[]> {
  const json = await fetchJson(
    'https://api.openai.com/v1/models',
    { headers: { authorization: `Bearer ${apiKey}` } },
    'OpenAI',
  );
  const data = Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: { id?: unknown }[] }).data)
    : [];
  return data
    .map((m) => (typeof m.id === 'string' ? m.id : ''))
    .filter((id) => id && !OPENAI_NON_CHAT.test(id))
    .sort((a, b) => b.localeCompare(a))
    .map((id) => ({ id }));
}

async function listAnthropicModels(apiKey: string): Promise<LlmModelInfo[]> {
  const json = await fetchJson(
    'https://api.anthropic.com/v1/models?limit=100',
    { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    'Anthropic',
  );
  const data = Array.isArray((json as { data?: unknown }).data)
    ? ((json as { data: { id?: unknown; display_name?: unknown }[] }).data)
    : [];
  return data
    .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: typeof m.display_name === 'string' ? m.display_name : null }));
}

async function listGoogleModels(apiKey: string): Promise<LlmModelInfo[]> {
  const json = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
    {},
    'Google',
  );
  const models = Array.isArray((json as { models?: unknown }).models)
    ? ((json as { models: { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }[] }).models)
    : [];
  return models
    .filter(
      (m) =>
        typeof m.name === 'string' &&
        Array.isArray(m.supportedGenerationMethods) &&
        (m.supportedGenerationMethods as unknown[]).includes('generateContent'),
    )
    .map((m) => {
      const id = (m.name as string).replace(/^models\//, '');
      return { id, label: typeof m.displayName === 'string' ? m.displayName : null };
    });
}

async function fetchJson(url: string, init: RequestInit, providerLabel: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw BadRequest(`Não foi possível conectar à API da ${providerLabel} para listar os modelos.`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw BadRequest(`Chave de API inválida para a ${providerLabel}.`);
    }
    const detail = await res.text().catch(() => '');
    throw BadRequest(`Falha ao listar modelos da ${providerLabel} (${res.status}). ${detail.slice(0, 200)}`);
  }
  return res.json();
}
