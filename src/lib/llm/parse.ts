import type {
  AnalysisResult,
  ConsistencyFinding,
  ConsistencyKind,
  ConsistencySeverity,
  ExtractedType,
  ExtractionResult,
} from './types';

/**
 * Parsing defensivo das respostas do LLM, compartilhado pelos providers. Os
 * modelos podem devolver número/forma fora do esperado (string no lugar de
 * número, linhas sem valor etc.); aqui normalizamos e descartamos o lixo.
 */
export function coerceExtraction(parsed: unknown): ExtractionResult {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items = rawItems
    .map((it) => {
      const r = (it ?? {}) as Record<string, unknown>;
      const amount = typeof r.amount === 'number' ? Math.abs(r.amount) : Number(r.amount);
      const type: ExtractedType = r.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
      const date = typeof r.date === 'string' ? r.date : '';
      const description = typeof r.description === 'string' ? r.description.trim() : '';
      return {
        date,
        description,
        amount: Number.isFinite(amount) ? amount : 0,
        type,
        suggestedCategory: typeof r.suggestedCategory === 'string' ? r.suggestedCategory : null,
        confidence: typeof r.confidence === 'number' ? r.confidence : null,
      };
    })
    // descarta linhas claramente inválidas (sem valor ou sem descrição/data)
    .filter((it) => it.amount > 0 && it.description.length > 0 && it.date.length > 0);

  return {
    items,
    detectedCurrency: typeof obj.detectedCurrency === 'string' ? obj.detectedCurrency : null,
    notes: typeof obj.notes === 'string' ? obj.notes : null,
  };
}

/**
 * Normaliza a resposta de categorização para um array alinhado por índice com
 * as linhas de entrada (null = sem sugestão).
 */
export function coerceCategories(rowCount: number, parsed: unknown): (string | null)[] {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const cats = Array.isArray(obj.categories) ? obj.categories : [];
  return Array.from({ length: rowCount }, (_, i) => (typeof cats[i] === 'string' ? (cats[i] as string) : null));
}

const KINDS: ConsistencyKind[] = ['DUPLICATE', 'CATEGORY', 'AMOUNT'];
const SEVERITIES: ConsistencySeverity[] = ['high', 'medium', 'low'];

/**
 * Normaliza a resposta de análise de inconsistências: descarta achados sem tipo
 * válido ou sem transações referenciadas, e clampeia os campos. `maxIndex` é o
 * maior índice válido — referências fora da faixa são removidas.
 */
export function coerceAnalysis(parsed: unknown, maxIndex: number): AnalysisResult {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings = raw
    .map((f): ConsistencyFinding | null => {
      const r = (f ?? {}) as Record<string, unknown>;
      const kind = KINDS.includes(r.kind as ConsistencyKind) ? (r.kind as ConsistencyKind) : null;
      if (!kind) return null;
      const indices = Array.isArray(r.transactionIndices)
        ? Array.from(
            new Set(
              r.transactionIndices
                .map((n) => Math.trunc(Number(n)))
                .filter((n) => Number.isInteger(n) && n >= 0 && n <= maxIndex),
            ),
          )
        : [];
      if (indices.length === 0) return null;
      return {
        kind,
        severity: SEVERITIES.includes(r.severity as ConsistencySeverity)
          ? (r.severity as ConsistencySeverity)
          : 'medium',
        title: typeof r.title === 'string' ? r.title.trim().slice(0, 200) : 'Inconsistência',
        detail: typeof r.detail === 'string' ? r.detail.trim().slice(0, 500) : '',
        suggestion: typeof r.suggestion === 'string' ? r.suggestion.trim().slice(0, 300) : null,
        transactionIndices: indices,
      };
    })
    .filter((f): f is ConsistencyFinding => f !== null);

  return { findings };
}
