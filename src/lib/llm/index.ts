import { env } from '../../env';
import { decryptSecret } from '../secrets';
import { AnthropicExtractor } from './anthropic';
import { GoogleExtractor } from './google';
import { OpenAIExtractor } from './openai';
import { LLM_PROVIDERS, isLlmProvider } from './providers';
import type { DocumentExtractor } from './provider';
import type { LlmConfig, LlmProvider } from './types';

export type { DocumentExtractor } from './provider';
export type {
  AnalyzeInput,
  AnalyzeTransaction,
  AnalysisResult,
  CategorizeInput,
  ConsistencyFinding,
  ConsistencyKind,
  ConsistencySeverity,
  ExtractDocumentInput,
  ExtractedTransaction,
  ExtractedType,
  ExtractionResult,
  LlmConfig,
  LlmModelInfo,
  LlmProvider,
  RecurrenceFreq,
  RecurringCandidate,
  RecurringDetectInput,
  RecurringDetectResult,
  RecurringRefinement,
} from './types';
export { LLM_PROVIDERS, PROVIDER_LIST, isLlmProvider } from './providers';
export { listProviderModels } from './models';
export { dropInstallmentDuplicates } from './parse';

/** Campos de LLM vindos das settings do workspace (chave ainda cifrada). */
export interface WorkspaceLlmSettings {
  llmProvider?: string | null;
  llmModel?: string | null;
  llmApiKey?: string | null;
}

/** Resolve o provider efetivo: o do workspace, senão o default de env. */
function resolveProvider(settings?: WorkspaceLlmSettings | null): LlmProvider {
  const raw = settings?.llmProvider || env.LLM_PROVIDER;
  return raw && isLlmProvider(raw) ? raw : 'openai';
}

/** Chave de API do env usada como fallback para o provider informado. */
export function envApiKeyFor(provider: LlmProvider): string | null {
  switch (provider) {
    case 'openai':
      return env.OPENAI_API_KEY ?? null;
    case 'anthropic':
      return env.ANTHROPIC_API_KEY ?? null;
    case 'google':
      return env.GOOGLE_API_KEY ?? null;
    default:
      return null;
  }
}

/**
 * Resolve a config efetiva de LLM: o que o workspace definiu tem prioridade;
 * o que estiver vazio cai no default (modelo do provider ou de env; chave de
 * env por provider). A chave do workspace é decifrada aqui.
 */
export function resolveLlmConfig(settings?: WorkspaceLlmSettings | null): LlmConfig {
  const provider = resolveProvider(settings);
  // Modelo: o do workspace; senão o de env quando o provider bate com o de env;
  // senão o default do provider.
  const model =
    settings?.llmModel ||
    (provider === env.LLM_PROVIDER ? env.LLM_MODEL : '') ||
    LLM_PROVIDERS[provider].defaultModel;
  const apiKey = decryptSecret(settings?.llmApiKey) ?? envApiKeyFor(provider);
  return { provider, model, apiKey, maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS };
}

/**
 * Factory do extrator de documentos. Escolhe a implementação pela config
 * resolvida (settings do workspace > env). Para adicionar um novo provider,
 * implemente `DocumentExtractor` e adicione um case aqui — é o único ponto que
 * o resto do app precisa conhecer.
 */
export function getExtractor(config: LlmConfig): DocumentExtractor {
  switch (config.provider) {
    case 'openai':
      return new OpenAIExtractor(config);
    case 'anthropic':
      return new AnthropicExtractor(config);
    case 'google':
      return new GoogleExtractor(config);
    default:
      throw new Error(`Provider de LLM não suportado: ${config.provider as string}`);
  }
}
