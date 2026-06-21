import type { LlmProvider } from './types';

/**
 * Catálogo dos providers de LLM suportados. Fonte única para rótulos, modelo
 * padrão e qual env var guarda a chave de cada um. Adicionar um provider novo =
 * registrá-lo aqui + implementar o `DocumentExtractor` e a busca de modelos.
 */
export interface ProviderInfo {
  id: LlmProvider;
  /** Nome exibido na UI. */
  label: string;
  /** Modelo padrão quando o workspace não define um (precisa ler imagem/PDF). */
  defaultModel: string;
  /** Nome da env var com a chave de API usada como fallback global. */
  envKey: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GOOGLE_API_KEY';
}

export const LLM_PROVIDERS: Record<LlmProvider, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    envKey: 'OPENAI_API_KEY',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-4-8',
    envKey: 'ANTHROPIC_API_KEY',
  },
  google: {
    id: 'google',
    label: 'Google (Gemini)',
    defaultModel: 'gemini-2.5-flash',
    envKey: 'GOOGLE_API_KEY',
  },
};

/** Lista de providers (em ordem de exibição) para o frontend. */
export const PROVIDER_LIST = Object.values(LLM_PROVIDERS);

/** True se a string é um provider conhecido. */
export function isLlmProvider(value: string): value is LlmProvider {
  return value === 'openai' || value === 'anthropic' || value === 'google';
}
