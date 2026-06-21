/**
 * Tipos compartilhados da camada de LLM. São agnósticos de provider — a
 * implementação concreta (OpenAI hoje) fica em arquivos próprios e o resto do
 * app só conhece estas interfaces.
 */

export type ExtractedType = 'INCOME' | 'EXPENSE';

/** Providers de LLM suportados. */
export type LlmProvider = 'openai' | 'anthropic' | 'google';

/** Um modelo disponível em um provider, devolvido pela busca via API. */
export interface LlmModelInfo {
  /** Identificador usado nas chamadas (ex.: "gpt-4o", "claude-opus-4-8"). */
  id: string;
  /** Rótulo amigável quando o provider fornece (ex.: "Claude Opus 4.8"). */
  label?: string | null;
}

/**
 * Configuração resolvida do provider de LLM para uma requisição. Vem das
 * settings do workspace quando definidas, com fallback nos defaults de env.
 */
export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  /** Chave de API já decifrada; null = não configurada. */
  apiKey: string | null;
  maxOutputTokens: number;
}

/** Uma transação extraída de um documento, antes da revisão do usuário. */
export interface ExtractedTransaction {
  /** Data de competência, ISO (yyyy-mm-dd). */
  date: string;
  description: string;
  /** Sempre positivo; o sinal vem do `type`. */
  amount: number;
  type: ExtractedType;
  /** Nome de categoria sugerido pela IA (cru, ainda não resolvido). */
  suggestedCategory?: string | null;
  /** 0..1 — confiança da IA na linha. */
  confidence?: number | null;
}

export interface ExtractionResult {
  items: ExtractedTransaction[];
  detectedCurrency?: string | null;
  notes?: string | null;
}

/** Documento binário (PDF/imagem) a ser lido pela IA. */
export interface ExtractDocumentInput {
  data: Buffer;
  mimeType: string;
  filename?: string;
  source: 'PDF' | 'IMAGE';
  /** Categorias existentes do workspace, p/ guiar a sugestão. */
  categoryNames?: string[];
}

/** Linhas já parseadas (CSV/OFX) que só precisam de categorização. */
export interface CategorizeInput {
  rows: { description: string; type: ExtractedType }[];
  categoryNames: string[];
}
