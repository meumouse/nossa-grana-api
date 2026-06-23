import type { ImportSource } from '@prisma/client';
import { BadRequest } from '../../lib/errors';

/**
 * Descobre o tipo de fonte (PDF/IMAGE/CSV/OFX) a partir do mime/extensão do
 * arquivo enviado. Compartilhado entre a importação por IA e a página de
 * Documentos. Lança BadRequest p/ formatos não suportados.
 */
export function detectSource(filename: string, mimeType: string): ImportSource {
  const name = filename.toLowerCase();
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'PDF';
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (name.endsWith('.ofx') || /ofx|sgml/i.test(mimeType)) return 'OFX';
  if (
    name.endsWith('.csv') ||
    mimeType === 'text/csv' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'text/plain'
  ) {
    return 'CSV';
  }
  throw BadRequest('Formato não suportado. Envie PDF, imagem, CSV ou OFX.');
}
