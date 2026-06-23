import { PDFDocument } from 'pdf-lib';

/**
 * Fraciona um PDF em pedaços de `pagesPerChunk` páginas cada, devolvendo um
 * Buffer por chunk (cada um é um PDF válido e autossuficiente).
 *
 * Por quê: documentos grandes em uma única chamada de IA são lidos com menos
 * precisão (e a resposta pode truncar). Quebrar por páginas mantém cada pedaço
 * dentro do que o modelo lê bem, e os resultados são concatenados depois.
 *
 * Degrada com segurança: se `pagesPerChunk <= 0`, o PDF não abre (cifrado/
 * corrompido) ou tem poucas páginas, devolve `[data]` — i.e., processa o
 * documento inteiro de uma vez (comportamento anterior).
 */
export async function splitPdfPages(data: Buffer, pagesPerChunk: number): Promise<Buffer[]> {
  if (pagesPerChunk <= 0) return [data];

  let src: PDFDocument;
  try {
    src = await PDFDocument.load(data, { ignoreEncryption: true });
  } catch {
    return [data];
  }

  const total = src.getPageCount();
  if (total <= pagesPerChunk) return [data];

  const chunks: Buffer[] = [];
  for (let start = 0; start < total; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, total);
    const sub = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, k) => start + k);
    const pages = await sub.copyPages(src, indices);
    pages.forEach((p) => sub.addPage(p));
    const bytes = await sub.save();
    chunks.push(Buffer.from(bytes));
  }
  return chunks;
}

/** Conta as páginas de um PDF via pdf-lib; null se não der p/ abrir. */
export async function countPdfPages(data: Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(data, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return null;
  }
}
