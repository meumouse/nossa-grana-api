/**
 * Utilitários de data. Trabalhamos em UTC para evitar surpresas de fuso na
 * persistência; a apresentação (timezone do usuário) é responsabilidade do
 * cliente. Datas "de calendário" (mês de orçamento, vencimento) são normalizadas
 * para meia-noite UTC.
 */

export function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/** Soma meses preservando o "fim do mês" (31 jan + 1 mês = 28/29 fev). */
export function addMonths(d: Date, months: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth());
  target.setUTCDate(Math.min(day, lastDay));
  return startOfDayUTC(target);
}

export function lastDayOfMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

/** Primeiro dia (civil) do mês de `d`, à meia-noite UTC. */
export function firstDayOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Início do "mês financeiro" que contém `d`, considerando `monthStartDay`
 * (ex.: quem organiza por data de salário no dia 5). Se o dia de `d` for >= ao
 * dia de início, o período começa neste mês; senão, no mês anterior.
 */
export function financialMonthStart(d: Date, monthStartDay: number): Date {
  const day = Math.min(Math.max(monthStartDay, 1), 28); // clamp p/ existir todo mês
  const ref = startOfDayUTC(d);
  if (ref.getUTCDate() >= day) {
    return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day));
  }
  const prev = addMonths(ref, -1);
  return new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), day));
}

/** Data com um dia-do-mês específico, respeitando meses curtos (clamp). */
export function withDayOfMonth(year: number, monthZeroBased: number, day: number): Date {
  const clamped = Math.min(day, lastDayOfMonth(year, monthZeroBased));
  return new Date(Date.UTC(year, monthZeroBased, clamped));
}
