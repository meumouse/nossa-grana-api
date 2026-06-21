import OpenAI from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { BadRequest } from '../errors';
import { rethrowLlmError } from './llm-error';
import { coerceAnalysis, coerceCategories, coerceExtraction } from './parse';
import type { DocumentExtractor } from './provider';
import type {
  AnalyzeInput,
  AnalysisResult,
  CategorizeInput,
  ExtractDocumentInput,
  ExtractionResult,
  LlmConfig,
} from './types';
import {
  analysisJsonSchema,
  buildAnalysisPrompt,
  buildCategorizePrompt,
  buildExtractionPrompt,
  categorizeJsonSchema,
  extractionJsonSchema,
} from './schema';

function dataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

export class OpenAIExtractor implements DocumentExtractor {
  readonly modelLabel: string;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(config: LlmConfig) {
    if (!config.apiKey) {
      throw BadRequest(
        'Chave da OpenAI não configurada — defina-a em Configurações para usar a importação por IA.',
      );
    }
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.modelLabel = `openai:${config.model}`;
  }

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

    const completion = await this.client.chat.completions
      .create({
        model: this.model,
        max_completion_tokens: this.maxOutputTokens,
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
      })
      .catch((err) => rethrowLlmError(err, 'OpenAI'));

    const content = completion.choices[0]?.message?.content;
    if (!content) throw BadRequest('A IA não retornou conteúdo para o documento.');
    return coerceExtraction(JSON.parse(content));
  }

  async categorizeRows(input: CategorizeInput): Promise<(string | null)[]> {
    if (input.rows.length === 0) return [];

    const completion = await this.client.chat.completions
      .create({
        model: this.model,
        max_completion_tokens: this.maxOutputTokens,
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
      })
      .catch((err) => rethrowLlmError(err, 'OpenAI'));

    const content = completion.choices[0]?.message?.content;
    if (!content) return input.rows.map(() => null);

    return coerceCategories(input.rows.length, JSON.parse(content));
  }

  async analyzeTransactions(input: AnalyzeInput): Promise<AnalysisResult> {
    if (input.transactions.length === 0 || input.checks.length === 0) return { findings: [] };

    const completion = await this.client.chat.completions
      .create({
        model: this.model,
        max_completion_tokens: this.maxOutputTokens,
        messages: [
          { role: 'system', content: buildAnalysisPrompt(input.checks, input.categoryNames) },
          { role: 'user', content: JSON.stringify(input.transactions) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'analysis',
            strict: true,
            schema: analysisJsonSchema as unknown as Record<string, unknown>,
          },
        },
      })
      .catch((err) => rethrowLlmError(err, 'OpenAI'));

    const content = completion.choices[0]?.message?.content;
    if (!content) return { findings: [] };
    return coerceAnalysis(JSON.parse(content), input.transactions.length - 1);
  }
}
