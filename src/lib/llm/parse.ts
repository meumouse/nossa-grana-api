import type {
  AnalysisResult,
  AnalyzeTransaction,
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

const INSTALLMENT_RE = /\(?\b(\d{1,3})\s*\/\s*(\d{1,3})\b\)?/g;

/**
 * Extrai um marcador de parcela "(n/total)" da descrição (ex.: "Geladeira (3/10)").
 * Devolve a base sem o marcador (normalizada) + o número da parcela e o total,
 * ou null se não houver marcador plausível. Usa a ÚLTIMA ocorrência, que é onde
 * o marcador costuma estar.
 */
function parseInstallment(description: string): { base: string; n: number; total: number } | null {
  let match: RegExpExecArray | null;
  let last: { idx: number; len: number; n: number; total: number } | null = null;
  INSTALLMENT_RE.lastIndex = 0;
  while ((match = INSTALLMENT_RE.exec(description)) !== null) {
    const n = Number(match[1]);
    const total = Number(match[2]);
    if (total >= 2 && n >= 1 && n <= total) last = { idx: match.index, len: match[0].length, n, total };
  }
  if (!last) return null;
  const base = (description.slice(0, last.idx) + description.slice(last.idx + last.len))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return { base, n: last.n, total: last.total };
}

/**
 * Guard determinístico contra falsos positivos de DUPLICATE em parcelamentos.
 * Parcelas de uma mesma compra (mesma base de descrição e mesmo total, com número
 * de parcela distinto) NÃO são duplicatas — são lançamentos legítimos em sequência.
 * O modelo às vezes as agrupa mesmo instruído a não fazê-lo; aqui removemos essas
 * transações do achado e descartamos o achado se sobrar menos de 2.
 */
export function dropInstallmentDuplicates(
  result: AnalysisResult,
  transactions: AnalyzeTransaction[],
): AnalysisResult {
  const byIndex = new Map(transactions.map((t) => [t.index, t]));
  const installmentOf = (i: number) => {
    const tx = byIndex.get(i);
    return tx ? parseInstallment(tx.description) : null;
  };

  const findings = result.findings
    .map((f): ConsistencyFinding => {
      if (f.kind !== 'DUPLICATE') return f;
      // Conta os números de parcela distintos por série (base|total).
      const series = new Map<string, Set<number>>();
      for (const i of f.transactionIndices) {
        const inst = installmentOf(i);
        if (!inst) continue;
        const key = `${inst.base}|${inst.total}`;
        const set = series.get(key) ?? new Set<number>();
        set.add(inst.n);
        series.set(key, set);
      }
      // Séries com 2+ parcelas distintas são parcelamentos legítimos.
      const installmentKeys = new Set(
        [...series.entries()].filter(([, ns]) => ns.size >= 2).map(([k]) => k),
      );
      if (installmentKeys.size === 0) return f;
      const kept = f.transactionIndices.filter((i) => {
        const inst = installmentOf(i);
        return !inst || !installmentKeys.has(`${inst.base}|${inst.total}`);
      });
      return { ...f, transactionIndices: kept };
    })
    .filter((f) => f.transactionIndices.length >= (f.kind === 'DUPLICATE' ? 2 : 1));

  return { findings };
}
