import { splitPdfPages } from '../pdf';
import type { DocumentExtractor } from './provider';
import type { CategorizeInput, ExtractDocumentInput, ExtractionResult } from './types';

export interface ChunkOptions {
  /** Páginas por chunk de PDF. <=0 desliga o fracionamento (chamada única). */
  pdfChunkPages: number;
  /** Chunks processados em paralelo. */
  concurrency: number;
  /** Reporta progresso (chunks concluídos / total) — só chamado quando fraciona. */
  onProgress?: (done: number, total: number) => void;
}

export interface ChunkedExtractionResult extends ExtractionResult {
  /** Quantos pedaços foram enviados à IA (1 = não fracionou). */
  chunkCount: number;
}

/**
 * Roda `tasks` com concorrência limitada, preservando a ordem dos resultados.
 * Uma task que rejeita propaga (Promise.all), abortando o lote — desejado: um
 * chunk ilegível deve falhar a importação com erro claro, não sumir em silêncio.
 */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

/**
 * Extrai um documento fracionando PDFs grandes em chunks de páginas e juntando
 * os resultados. Imagens não são fracionadas (não há corte confiável de um
 * raster) — chamada única. PDFs pequenos ou ilegíveis caem na chamada única
 * (ver `splitPdfPages`).
 */
export async function extractDocumentChunked(
  extractor: DocumentExtractor,
  input: ExtractDocumentInput,
  opts: ChunkOptions,
): Promise<ChunkedExtractionResult> {
  if (input.source !== 'PDF' || opts.pdfChunkPages <= 0) {
    const single = await extractor.extractFromDocument(input);
    return { ...single, chunkCount: 1 };
  }

  const chunks = await splitPdfPages(input.data, opts.pdfChunkPages);
  if (chunks.length <= 1) {
    const single = await extractor.extractFromDocument(input);
    return { ...single, chunkCount: 1 };
  }

  opts.onProgress?.(0, chunks.length);
  let done = 0;
  const results = await mapPool(chunks, opts.concurrency, async (data) => {
    const r = await extractor.extractFromDocument({ ...input, data });
    // JS é single-thread: o incremento é seguro mesmo com o pool concorrente.
    done += 1;
    opts.onProgress?.(done, chunks.length);
    return r;
  });

  const items = results.flatMap((r) => r.items);
  const detectedCurrency = results.find((r) => r.detectedCurrency)?.detectedCurrency ?? null;
  const notes = results.map((r) => r.notes).filter(Boolean).join(' ') || null;
  return { items, detectedCurrency, notes, chunkCount: chunks.length };
}

/**
 * Categoriza linhas (CSV/OFX) em lotes, concatenando os resultados alinhados por
 * índice. Mesma ideia do fracionamento de PDF: extratos com muitas linhas em uma
 * só chamada degradam/truncam. `chunkRows <= 0` faz uma única chamada.
 */
export async function categorizeRowsChunked(
  extractor: DocumentExtractor,
  input: CategorizeInput,
  chunkRows: number,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<(string | null)[]> {
  if (chunkRows <= 0 || input.rows.length <= chunkRows) {
    return extractor.categorizeRows(input);
  }

  const batches: CategorizeInput['rows'][] = [];
  for (let i = 0; i < input.rows.length; i += chunkRows) {
    batches.push(input.rows.slice(i, i + chunkRows));
  }
  onProgress?.(0, batches.length);
  let done = 0;
  const results = await mapPool(batches, concurrency, async (rows) => {
    const r = await extractor.categorizeRows({ rows, categoryNames: input.categoryNames });
    done += 1;
    onProgress?.(done, batches.length);
    return r;
  });
  return results.flat();
}
