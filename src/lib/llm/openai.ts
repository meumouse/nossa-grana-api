import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { env } from '../../env';
import { BadRequest } from '../errors';
import type { DocumentExtractor } from './provider';
import type { CategorizeInput, ExtractDocumentInput, ExtractedType, ExtractionResult } from './types';
import {
  buildCategorizePrompt,
  buildExtractionPrompt,
  categorizeJsonSchema,
  extractionJsonSchema,
} from './schema';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw BadRequest('OPENAI_API_KEY não configurada — defina-a para usar a importação por IA.');
  }
  client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

function dataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

/** Parse defensivo: o LLM pode devolver número/forma fora do esperado. */
function coerceItems(parsed: unknown): ExtractionResult {
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

export class OpenAIExtractor implements DocumentExtractor {
  readonly modelLabel = `openai:${env.LLM_MODEL}`;

  async extractFromDocument(input: ExtractDocumentInput): Promise<ExtractionResult> {
    const filePart: ChatCompletionContentPart =
      input.source === 'IMAGE'
        ? { type: 'image_url', image_url: { url: dataUrl(input.mimeType, input.data) } }
        : {
            type: 'file',
            file: {
              filename: input.filename ?? 'documento.pdf',
              file_data: dataUrl(input.mimeType, input.data),
            },
          };

    const completion = await getClient().chat.completions.create({
      model: env.LLM_MODEL,
      max_completion_tokens: env.LLM_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: buildExtractionPrompt(input.categoryNames) },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extraia as transações deste documento.' },
            filePart,
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'extraction',
          strict: true,
          schema: extractionJsonSchema as unknown as Record<string, unknown>,
        },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw BadRequest('A IA não retornou conteúdo para o documento.');
    return coerceItems(JSON.parse(content));
  }

  async categorizeRows(input: CategorizeInput): Promise<(string | null)[]> {
    if (input.rows.length === 0) return [];

    const completion = await getClient().chat.completions.create({
      model: env.LLM_MODEL,
      max_completion_tokens: env.LLM_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: buildCategorizePrompt(input.categoryNames) },
        {
          role: 'user',
          content: JSON.stringify(
            input.rows.map((r, i) => ({ index: i, description: r.description, type: r.type })),
          ),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'categorize',
          strict: true,
          schema: categorizeJsonSchema as unknown as Record<string, unknown>,
        },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return input.rows.map(() => null);

    const parsed = JSON.parse(content) as { categories?: unknown };
    const cats = Array.isArray(parsed.categories) ? parsed.categories : [];
    // garante alinhamento por índice com as linhas de entrada
    return input.rows.map((_, i) => (typeof cats[i] === 'string' ? (cats[i] as string) : null));
  }
}
