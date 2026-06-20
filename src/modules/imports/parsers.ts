import Papa from 'papaparse';
import { BadRequest } from '../../lib/errors';
import type { ExtractedType } from '../../lib/llm';

/** Linha estruturada extraída de CSV/OFX, antes da categorização. */
export interface ParsedRow {
  date: Date;
  description: string;
  amount: number; // sempre positivo
  type: ExtractedType;
}

/** Converte "1.234,56", "-1234.56", "R$ (1.234,56)" etc. em número (com sinal). */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim().replace(/r\$/i, '').replace(/\s/g, '');
  if (!s) return null;
  // parênteses = negativo (contabilidade)
  const negParen = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  const neg = negParen || s.startsWith('-');
  s = s.replace(/^[+-]/, '');

  // Decide separador decimal: se tem vírgula e ponto, o último é o decimal.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // BR: 1.234,56
    } else {
      s = s.replace(/,/g, ''); // US: 1,234.56
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.'); // 1234,56
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Converte datas comuns (dd/mm/aaaa, aaaa-mm-dd, aaaammdd) em Date. */
export function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let m: RegExpMatchArray | null;

  // dd/mm/aaaa ou dd-mm-aaaa (aceita ano com 2 ou 4 dígitos)
  if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/))) {
    const [, d, mo, y] = m;
    if (!d || !mo || !y) return null;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const dt = new Date(Date.UTC(year, Number(mo) - 1, Number(d)));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  // aaaa-mm-dd
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  // aaaammdd (OFX, primeiros 8 dígitos)
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) {
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function toRow(date: Date, description: string, signed: number): ParsedRow | null {
  const desc = description.trim();
  if (!desc || signed === 0) return null;
  return {
    date,
    description: desc,
    amount: Math.abs(signed),
    type: signed < 0 ? 'EXPENSE' : 'INCOME',
  };
}

const matches = (key: string, re: RegExp) => re.test(key);

/** Parse heurístico de CSV de banco: detecta colunas por nome de cabeçalho. */
export function parseCsv(content: string): ParsedRow[] {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const fields = result.meta.fields ?? [];
  if (fields.length === 0) throw BadRequest('CSV sem cabeçalho reconhecível.');

  const norm = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const find = (re: RegExp) => fields.find((f) => matches(norm(f), re));

  const dateCol = find(/data|date|dt/);
  const descCol = find(/descri|histor|hist|memo|lancamento|estabelec|name|titulo/);
  const amountCol = find(/valor|amount|montante|quantia/);
  const debitCol = find(/debito|debit|saida/);
  const creditCol = find(/credito|credit|entrada/);

  if (!dateCol || !descCol || (!amountCol && !debitCol && !creditCol)) {
    throw BadRequest(
      'Não consegui identificar as colunas do CSV (precisa de data, descrição e valor).',
    );
  }

  const rows: ParsedRow[] = [];
  for (const r of result.data) {
    const date = parseDate(r[dateCol] ?? '');
    if (!date) continue;
    const description = r[descCol] ?? '';

    let signed: number | null = null;
    if (amountCol) {
      signed = parseAmount(r[amountCol] ?? '');
    } else {
      const debit = debitCol ? parseAmount(r[debitCol] ?? '') : null;
      const credit = creditCol ? parseAmount(r[creditCol] ?? '') : null;
      if (debit && debit !== 0) signed = -Math.abs(debit);
      else if (credit && credit !== 0) signed = Math.abs(credit);
    }
    if (signed == null) continue;

    const row = toRow(date, description, signed);
    if (row) rows.push(row);
  }

  if (rows.length === 0) throw BadRequest('Nenhuma transação válida encontrada no CSV.');
  return rows;
}

/** Parse de OFX (formato SGML): cada <STMTTRN> é uma transação. */
export function parseOfx(content: string): ParsedRow[] {
  const blocks = content.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  const tag = (block: string, name: string) => {
    // OFX permite tags sem fechamento: <MEMO>valor\n<PRÓXIMA>
    const m = block.match(new RegExp(`<${name}>([^<\r\n]*)`, 'i'));
    return m?.[1]?.trim() ?? '';
  };

  const rows: ParsedRow[] = [];
  for (const block of blocks) {
    const date = parseDate(tag(block, 'DTPOSTED'));
    const signed = parseAmount(tag(block, 'TRNAMT'));
    const description = tag(block, 'MEMO') || tag(block, 'NAME') || tag(block, 'TRNTYPE');
    if (!date || signed == null) continue;
    const row = toRow(date, description, signed);
    if (row) rows.push(row);
  }

  if (rows.length === 0) throw BadRequest('Nenhuma transação encontrada no arquivo OFX.');
  return rows;
}
