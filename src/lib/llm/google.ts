import { BadRequest } from '../errors';
import { rethrowLlmError } from './llm-error';
import { coerceAnalysis, coerceCategories, coerceExtraction, coerceRecurringDetect } from './parse';
import type { DocumentExtractor } from './provider';
import type {
  AnalyzeInput,
  AnalysisResult,
  CategorizeInput,
  ExtractDocumentInput,
  ExtractionResult,
  LlmConfig,
  RecurringDetectInput,
  RecurringDetectResult,
} from './types';
import {
  buildAnalysisPrompt,
  buildCategorizePrompt,
  buildExtractionPrompt,
  buildRecurringDetectPrompt,
} from './schema';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Schemas no dialeto do Gemini (`responseSchema`, subconjunto do OpenAPI 3.0):
 * tipos em MAIÚSCULAS (enum `Type` da API), `nullable` em vez de union types e
 * sem `additionalProperties`. Equivalem aos JSON Schemas de schema.ts.
 */
const geminiExtractionSchema = {
  type: 'OBJECT',
  properties: {
    detectedCurrency: { type: 'STRING', nullable: true },
    notes: { type: 'STRING', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING' },
          description: { type: 'STRING' },
          amount: { type: 'NUMBER' },
          type: { type: 'STRING', enum: ['INCOME', 'EXPENSE'] },
          suggestedCategory: { type: 'STRING', nullable: true },
          confidence: { type: 'NUMBER', nullable: true },
        },
        required: ['date', 'description', 'amount', 'type'],
      },
    },
  },
  required: ['items'],
};

const geminiCategorizeSchema = {
  type: 'OBJECT',
  properties: {
    categories: { type: 'ARRAY', items: { type: 'STRING', nullable: true } },
  },
  required: ['categories'],
};

const geminiAnalysisSchema = {
  type: 'OBJECT',
  properties: {
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['DUPLICATE', 'CATEGORY', 'AMOUNT'] },
          severity: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          title: { type: 'STRING' },
          detail: { type: 'STRING' },
          suggestion: { type: 'STRING', nullable: true },
          transactionIndices: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
        required: ['kind', 'severity', 'title', 'detail', 'transactionIndices'],
      },
    },
  },
  required: ['findings'],
};

const geminiRecurringSchema = {
  type: 'OBJECT',
  properties: {
    refinements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          isRecurring: { type: 'BOOLEAN' },
          label: { type: 'STRING', nullable: true },
          suggestedCategory: { type: 'STRING', nullable: true },
          confidence: { type: 'NUMBER', nullable: true },
        },
        required: ['id', 'isRecurring'],
      },
    },
  },
  required: ['refinements'],
};

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * Extrator via Gemini (Google). Usa a REST `generateContent` com
 * `responseSchema` para forçar JSON estruturado e `inlineData` (base64) para
 * enviar o PDF/imagem. Reaproveita os prompts PT-BR de schema.ts.
 */
export class GoogleExtractor implements DocumentExtractor {
  readonly modelLabel: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(config: LlmConfig) {
    if (!config.apiKey) {
      throw BadRequest(
        'Chave do Google (Gemini) não configurada — defina-a em Configurações para usar a importação por IA.',
      );
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.modelLabel = `google:${config.model}`;
  }

  private async generate(system: string, parts: GeminiPart[], responseSchema: object): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(
        `${GEMINI_BASE}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema,
              maxOutputTokens: this.maxOutputTokens,
            },
          }),
        },
      );
    } catch {
      throw BadRequest('Não foi possível conectar à API do Gemini.');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      rethrowLlmError({ status: res.status, message: detail }, 'Gemini');
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw BadRequest('A IA não retornou conteúdo para o documento.');
    return JSON.parse(text);
  }

  async extractFromDocument(input: ExtractDocumentInput): Promise<ExtractionResult> {
    const parsed = await this.generate(
      buildExtractionPrompt(input.categoryNames),
      [
        { text: 'Extraia as transações deste documento.' },
        { inlineData: { mimeType: input.mimeType, data: input.data.toString('base64') } },
      ],
      geminiExtractionSchema,
    );
    return coerceExtraction(parsed);
  }

  async categorizeRows(input: CategorizeInput): Promise<(string | null)[]> {
    if (input.rows.length === 0) return [];

    const parsed = await this.generate(
      buildCategorizePrompt(input.categoryNames),
      [
        {
          text: JSON.stringify(
            input.rows.map((r, i) => ({ index: i, description: r.description, type: r.type })),
          ),
        },
      ],
      geminiCategorizeSchema,
    );
    return coerceCategories(input.rows.length, parsed);
  }

  async analyzeTransactions(input: AnalyzeInput): Promise<AnalysisResult> {
    if (input.transactions.length === 0 || input.checks.length === 0) return { findings: [] };

    const parsed = await this.generate(
      buildAnalysisPrompt(input.checks, input.categoryNames),
      [{ text: JSON.stringify(input.transactions) }],
      geminiAnalysisSchema,
    );
    return coerceAnalysis(parsed, input.transactions.length - 1);
  }

  async detectRecurring(input: RecurringDetectInput): Promise<RecurringDetectResult> {
    if (input.candidates.length === 0) return { refinements: [] };

    const parsed = await this.generate(
      buildRecurringDetectPrompt(input.categoryNames),
      [{ text: JSON.stringify(input.candidates) }],
      geminiRecurringSchema,
    );
    return coerceRecurringDetect(parsed, new Set(input.candidates.map((c) => c.id)));
  }
}
