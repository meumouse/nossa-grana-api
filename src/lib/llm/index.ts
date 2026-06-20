import { env } from '../../env';
import { OpenAIExtractor } from './openai';
import type { DocumentExtractor } from './provider';

export type { DocumentExtractor } from './provider';
export type {
  CategorizeInput,
  ExtractDocumentInput,
  ExtractedTransaction,
  ExtractedType,
  ExtractionResult,
} from './types';

/**
 * Factory do extrator de documentos. Escolhe a implementação pelo env
 * (`LLM_PROVIDER`). Para adicionar um novo provider (Claude, Gemini...),
 * implemente `DocumentExtractor` e adicione um case aqui — é o único ponto
 * que o resto do app precisa conhecer.
 */
export function getExtractor(): DocumentExtractor {
  switch (env.LLM_PROVIDER) {
    case 'openai':
      return new OpenAIExtractor();
    default:
      // env já valida o enum; este branch é só p/ exaustividade de tipos.
      throw new Error(`Provider de LLM não suportado: ${env.LLM_PROVIDER as string}`);
  }
}
