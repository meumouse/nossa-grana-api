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

// ---- Verificação de inconsistências do extrato ----

/** Tipos de checagem que a IA pode rodar sobre o extrato. */
export type ConsistencyKind = 'DUPLICATE' | 'CATEGORY' | 'AMOUNT';

export type ConsistencySeverity = 'high' | 'medium' | 'low';

/** Uma transação enviada para análise (referenciada pelo `index` na resposta). */
export interface AnalyzeTransaction {
  index: number;
  date: string;
  description: string;
  amount: number;
  type: ExtractedType;
  category?: string | null;
}

export interface AnalyzeInput {
  transactions: AnalyzeTransaction[];
  /** Checagens habilitadas pelo usuário. */
  checks: ConsistencyKind[];
  categoryNames?: string[];
}

// ---- Detecção de recorrências ----

/** Frequência de recorrência (espelha o enum do Prisma, sem acoplar a ele). */
export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/**
 * Uma série candidata a recorrência, já agrupada deterministicamente no backend
 * (mesma descrição/valor em cadência regular). A IA só refina/confirma.
 */
export interface RecurringCandidate {
  /** Índice estável p/ casar a resposta da IA com o candidato. */
  id: number;
  description: string;
  type: ExtractedType;
  /** Valor típico (mediana) da série. */
  amount: number;
  frequency: RecurrenceFreq;
  interval: number;
  /** Quantas vezes a série apareceu no extrato. */
  occurrences: number;
  /** Datas ISO (yyyy-mm-dd) das ocorrências, p/ contexto da IA. */
  dates: string[];
}

export interface RecurringDetectInput {
  candidates: RecurringCandidate[];
  categoryNames?: string[];
}

/** Refino da IA p/ um candidato (casado por `id`). */
export interface RecurringRefinement {
  id: number;
  /** false = a IA julga que NÃO é uma recorrência real (descartar). */
  isRecurring: boolean;
  /** Nome amigável sugerido (ex.: "Netflix"). null mantém o original. */
  label?: string | null;
  /** Categoria sugerida (preferir uma existente). null se incerto. */
  suggestedCategory?: string | null;
  /** Confiança 0..1 de que é recorrência. */
  confidence?: number | null;
}

export interface RecurringDetectResult {
  refinements: RecurringRefinement[];
}

/** Um achado da análise. `transactionIndices` referencia AnalyzeTransaction.index. */
export interface ConsistencyFinding {
  kind: ConsistencyKind;
  severity: ConsistencySeverity;
  title: string;
  detail: string;
  suggestion?: string | null;
  transactionIndices: number[];
}

export interface AnalysisResult {
  findings: ConsistencyFinding[];
}
