import type { PrismaClient } from '@prisma/client';
import { addDays, addMonths, startOfDayUTC, withDayOfMonth } from '../../lib/dates';
import { getExtractor, resolveLlmConfig } from '../../lib/llm';
import type { RecurrenceFreq, RecurringCandidate } from '../../lib/llm';

/** Uma recorrência sugerida (série regular ainda sem template cadastrado). */
export interface RecurringSuggestion {
  description: string;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  accountId: string;
  categoryId: string | null;
  /** Nome de categoria sugerido pela IA (cru), quando houver. */
  suggestedCategory: string | null;
  frequency: RecurrenceFreq;
  interval: number;
  anchorDay: number | null;
  /** Data da 1ª ocorrência observada (ISO yyyy-mm-dd). */
  startDate: string;
  /** Próxima ocorrência projetada após a última observada (ISO yyyy-mm-dd). */
  nextDate: string;
  /** 0..1 — confiança na regularidade da série. */
  confidence: number;
  /** Quantas vezes a série apareceu no extrato. */
  occurrences: number;
  /** Ids das transações existentes que compõem a série (p/ vincular ao criar). */
  transactionIds: string[];
}

const MIN_OCCURRENCES = 3;
const LOOKBACK_MONTHS = 12;
/** Coeficiente de variação máximo dos espaçamentos p/ aceitar como "regular". */
const MAX_GAP_CV = 0.5;
const MAX_LLM_CANDIDATES = 40;

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Valor mais frequente (mode) de uma lista; primeiro em empate. */
function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/** Classifica o espaçamento mediano (em dias) numa cadência. null se irregular. */
function classifyCadence(gapDays: number): { frequency: RecurrenceFreq; interval: number } | null {
  if (gapDays >= 0.5 && gapDays <= 2) return { frequency: 'DAILY', interval: 1 };
  if (gapDays >= 5 && gapDays <= 10) return { frequency: 'WEEKLY', interval: 1 };
  if (gapDays >= 11 && gapDays <= 18) return { frequency: 'WEEKLY', interval: 2 };
  if (gapDays >= 25 && gapDays <= 38) return { frequency: 'MONTHLY', interval: 1 };
  if (gapDays >= 50 && gapDays <= 70) return { frequency: 'MONTHLY', interval: 2 };
  if (gapDays >= 80 && gapDays <= 100) return { frequency: 'MONTHLY', interval: 3 };
  if (gapDays >= 170 && gapDays <= 195) return { frequency: 'MONTHLY', interval: 6 };
  if (gapDays >= 350 && gapDays <= 380) return { frequency: 'YEARLY', interval: 1 };
  return null;
}

function stepFrom(d: Date, frequency: RecurrenceFreq, interval: number, anchorDay: number | null): Date {
  switch (frequency) {
    case 'DAILY':
      return addDays(d, interval);
    case 'WEEKLY':
      return addDays(d, 7 * interval);
    case 'MONTHLY': {
      const next = addMonths(d, interval);
      return anchorDay != null
        ? withDayOfMonth(next.getUTCFullYear(), next.getUTCMonth(), anchorDay)
        : next;
    }
    case 'YEARLY':
      return addMonths(d, 12 * interval);
    default:
      return addMonths(d, interval);
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

interface GroupTx {
  id: string;
  date: Date;
  amount: number;
  categoryId: string | null;
}

/**
 * Detecta séries recorrentes no extrato e devolve sugestões de cadastro.
 *
 * Híbrido: (1) agrupa deterministicamente transações COMPLETED por descrição
 * normalizada + conta + tipo, exige cadência regular (≥3 ocorrências) e exclui
 * séries já cobertas por uma recorrência existente; (2) refina com a IA quando
 * houver chave configurada (best-effort — falha não derruba o resultado).
 */
export async function suggestRecurring(
  db: PrismaClient,
  workspaceId: string,
): Promise<RecurringSuggestion[]> {
  const since = addMonths(startOfDayUTC(new Date()), -LOOKBACK_MONTHS);
  const today = startOfDayUTC(new Date());

  const txs = await db.transaction.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      status: 'COMPLETED',
      type: { in: ['INCOME', 'EXPENSE'] },
      accountId: { not: null },
      recurringTransactionId: null, // só séries ainda NÃO vinculadas a uma recorrência
      date: { gte: since },
    },
    select: { id: true, date: true, amount: true, type: true, accountId: true, categoryId: true, description: true },
    orderBy: { date: 'asc' },
  });

  // Séries já cobertas por uma recorrência ativa: não sugerir de novo.
  const existing = await db.recurringTransaction.findMany({
    where: { workspaceId, isActive: true, deletedAt: null },
    select: { accountId: true, type: true, description: true },
  });
  const covered = new Set(existing.map((r) => `${r.accountId}|${r.type}|${norm(r.description)}`));

  // Agrupa por conta + tipo + descrição normalizada.
  const groups = new Map<string, { type: 'INCOME' | 'EXPENSE'; accountId: string; description: string; items: GroupTx[] }>();
  for (const t of txs) {
    if (!t.accountId) continue;
    const key = `${t.accountId}|${t.type}|${norm(t.description)}`;
    if (covered.has(key)) continue;
    const g = groups.get(key) ?? {
      type: t.type as 'INCOME' | 'EXPENSE',
      accountId: t.accountId,
      description: t.description,
      items: [],
    };
    g.items.push({ id: t.id, date: startOfDayUTC(t.date), amount: Number(t.amount), categoryId: t.categoryId });
    groups.set(key, g);
  }

  const suggestions: RecurringSuggestion[] = [];
  for (const g of groups.values()) {
    if (g.items.length < MIN_OCCURRENCES) continue;
    const items = g.items.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Espaçamentos (dias) entre ocorrências consecutivas.
    const gaps: number[] = [];
    for (let i = 1; i < items.length; i += 1) {
      gaps.push((items[i]!.date.getTime() - items[i - 1]!.date.getTime()) / 86_400_000);
    }
    const medianGap = median(gaps);
    if (medianGap <= 0) continue;

    const cadence = classifyCadence(medianGap);
    if (!cadence) continue;

    // Regularidade: coeficiente de variação dos espaçamentos.
    const meanGap = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    const variance = gaps.reduce((s, x) => s + (x - meanGap) ** 2, 0) / gaps.length;
    const cv = meanGap > 0 ? Math.sqrt(variance) / meanGap : 1;
    if (cv > MAX_GAP_CV) continue;

    const last = items[items.length - 1]!.date;
    // Série "viva": a última ocorrência não pode ser muito antiga (>2 ciclos).
    if ((today.getTime() - last.getTime()) / 86_400_000 > medianGap * 2 + 5) continue;

    const isMonthly = cadence.frequency === 'MONTHLY' || cadence.frequency === 'YEARLY';
    const anchorDay = isMonthly ? mode(items.map((it) => it.date.getUTCDate())) : null;
    const categoryId = mode(items.map((it) => it.categoryId).filter((c): c is string => c != null));

    suggestions.push({
      description: g.description,
      type: g.type,
      amount: median(items.map((it) => it.amount)),
      accountId: g.accountId,
      categoryId: categoryId ?? null,
      suggestedCategory: null,
      frequency: cadence.frequency,
      interval: cadence.interval,
      anchorDay,
      startDate: iso(items[0]!.date),
      nextDate: iso(stepFrom(last, cadence.frequency, cadence.interval, anchorDay)),
      confidence: Math.max(0.4, Math.min(0.95, 1 - cv)),
      occurrences: items.length,
      transactionIds: items.map((it) => it.id),
    });
  }

  // Mais ocorrências e maior confiança primeiro.
  suggestions.sort((a, b) => b.occurrences - a.occurrences || b.confidence - a.confidence);

  return refineWithAi(db, workspaceId, suggestions);
}

/**
 * Refino best-effort pela IA: confirma/descarta candidatos, ajusta nome e
 * confiança. Sem chave de LLM ou em caso de erro, devolve as sugestões
 * determinísticas intactas.
 */
async function refineWithAi(
  db: PrismaClient,
  workspaceId: string,
  suggestions: RecurringSuggestion[],
): Promise<RecurringSuggestion[]> {
  if (suggestions.length === 0) return suggestions;

  const settings = await db.workspaceSettings.findUnique({
    where: { workspaceId },
    select: { llmProvider: true, llmModel: true, llmApiKey: true },
  });
  const config = resolveLlmConfig(settings);
  if (!config.apiKey) return suggestions; // sem chave: fica só no determinístico

  const pool = suggestions.slice(0, MAX_LLM_CANDIDATES);
  const candidates: RecurringCandidate[] = pool.map((s, id) => ({
    id,
    description: s.description,
    type: s.type,
    amount: s.amount,
    frequency: s.frequency,
    interval: s.interval,
    occurrences: s.occurrences,
    dates: [s.startDate, s.nextDate],
  }));

  try {
    const categories = await db.category.findMany({
      where: { workspaceId, deletedAt: null, archived: false },
      select: { name: true },
    });
    const { refinements } = await getExtractor(config).detectRecurring({
      candidates,
      categoryNames: categories.map((c) => c.name),
    });
    const byId = new Map(refinements.map((r) => [r.id, r]));

    const refined = pool
      .map((s, id) => {
        const r = byId.get(id);
        if (!r) return s; // sem refino: mantém o determinístico
        if (!r.isRecurring) return null; // IA descartou
        return {
          ...s,
          description: r.label ?? s.description,
          suggestedCategory: r.suggestedCategory ?? s.suggestedCategory,
          confidence: r.confidence ?? s.confidence,
        };
      })
      .filter((s): s is RecurringSuggestion => s !== null);

    // Mantém também o que ficou fora do pool enviado à IA (não refinado).
    return [...refined, ...suggestions.slice(MAX_LLM_CANDIDATES)];
  } catch {
    return suggestions; // qualquer falha de IA: fallback determinístico
  }
}
