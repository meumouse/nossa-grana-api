import { env } from '../../env';
import { decryptSecret } from '../secrets';
import { OpenAIExtractor } from './openai';
import type { DocumentExtractor } from './provider';
import type { LlmConfig, LlmProvider } from './types';

export type { DocumentExtractor } from './provider';
export type {
  CategorizeInput,
  ExtractDocumentInput,
  ExtractedTransaction,
  ExtractedType,
  ExtractionResult,
  LlmConfig,
  LlmProvider,
} from './types';

/** Campos de LLM vindos das settings do workspace (chave ainda cifrada). */
export interface WorkspaceLlmSettings {
  llmProvider?: string | null;
  llmModel?: string | null;
  llmApiKey?: string | null;
}

/**
 * Resolve a config efetiva de LLM: o que o workspace definiu tem prioridade;
 * o que estiver vazio cai no default de env. A chave do workspace é decifrada
 * aqui; sem ela, usa a `OPENAI_API_KEY` do env (fallback).
 */
export function resolveLlmConfig(settings?: WorkspaceLlmSettings | null): LlmConfig {
  const provider = ((settings?.llmProvider || env.LLM_PROVIDER) as LlmProvider) ?? 'openai';
  const model = settings?.llmModel || env.LLM_MODEL;
  const apiKey = decryptSecret(settings?.llmApiKey) ?? env.OPENAI_API_KEY ?? null;
  return { provider, model, apiKey, maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS };
}

/**
 * Factory do extrator de documentos. Escolhe a implementação pela config
 * resolvida (settings do workspace > env). Para adicionar um novo provider
 * (Claude, Gemini...), implemente `DocumentExtractor` e adicione um case aqui —
 * é o único ponto que o resto do app precisa conhecer.
 */
export function getExtractor(config: LlmConfig): DocumentExtractor {
  switch (config.provider) {
    case 'openai':
      return new OpenAIExtractor(config);
    default:
      throw new Error(`Provider de LLM não suportado: ${config.provider as string}`);
  }
}
