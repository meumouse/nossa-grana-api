import type {
  AnalyzeInput,
  AnalysisResult,
  CategorizeInput,
  ExtractDocumentInput,
  ExtractionResult,
} from './types';

/**
 * Contrato de um provider de extração por LLM. Trocar de provider/modelo =
 * implementar esta interface e registrá-la no factory (index.ts). O resto do
 * app nunca importa OpenAI diretamente.
 */
export interface DocumentExtractor {
  /** Rótulo do modelo p/ auditoria, ex.: "openai:gpt-4o". */
  readonly modelLabel: string;

  /** Lê um documento (PDF/imagem) e devolve as transações encontradas. */
  extractFromDocument(input: ExtractDocumentInput): Promise<ExtractionResult>;

  /**
   * Sugere categoria p/ linhas já estruturadas (CSV/OFX). Devolve um array
   * alinhado por índice com `input.rows` (null = sem sugestão).
   */
  categorizeRows(input: CategorizeInput): Promise<(string | null)[]>;

  /**
   * Analisa um extrato (transações já estruturadas) em busca de inconsistências
   * (duplicatas, categorias suspeitas, valores atípicos). Não relê documentos.
   */
  analyzeTransactions(input: AnalyzeInput): Promise<AnalysisResult>;
}
