import Anthropic from '@anthropic-ai/sdk';
import { BadRequest } from '../errors';
import { rethrowLlmError } from './llm-error';
import { coerceCategories, coerceExtraction } from './parse';
import type { DocumentExtractor } from './provider';
import type { CategorizeInput, ExtractDocumentInput, ExtractionResult, LlmConfig } from './types';
import {
  buildCategorizePrompt,
  buildExtractionPrompt,
  categorizeJsonSchema,
  extractionJsonSchema,
} from './schema';

/** Media types de imagem aceitos pela API de visão da Anthropic. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

type InputSchema = Anthropic.Tool.InputSchema;

/**
 * Extrator via Claude (Anthropic). Usa a Messages API com forced tool use:
 * forçar uma ferramenta com `input_schema` é a forma mais portável de obter
 * JSON estruturado em qualquer modelo Claude (structured outputs nativo só
 * existe nos modelos mais novos). O `input` do bloco `tool_use` já vem parseado.
 */
export class AnthropicExtractor implements DocumentExtractor {
  readonly modelLabel: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(config: LlmConfig) {
    if (!config.apiKey) {
      throw BadRequest(
        'Chave da Anthropic não configurada — defina-a em Configurações para usar a importação por IA.',
      );
    }
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.modelLabel = `anthropic:${config.model}`;
  }

  /** Lê o `input` da ferramenta forçada na resposta (já é objeto JSON). */
  private async runTool(
    toolName: string,
    schema: InputSchema,
    system: string,
    userContent: Anthropic.ContentBlockParam[],
  ): Promise<unknown> {
    const message = await this.client.messages
      .create({
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system,
        tools: [{ name: toolName, description: 'Retorna o resultado estruturado.', input_schema: schema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: userContent }],
      })
      .catch((err) => rethrowLlmError(err, 'Anthropic'));
    const block = message.content.find((b) => b.type === 'tool_use');
    return block && block.type === 'tool_use' ? block.input : null;
  }

  async extractFromDocument(input: ExtractDocumentInput): Promise<ExtractionResult> {
    const data = input.data.toString('base64');
    const filePart: Anthropic.ContentBlockParam =
      input.source === 'IMAGE'
        ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (IMAGE_TYPES.includes(input.mimeType)
                ? input.mimeType
                : 'image/png') as 'image/png',
              data,
            },
          }
        : {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data },
          };

    const parsed = await this.runTool(
      'extraction',
      extractionJsonSchema as unknown as InputSchema,
      buildExtractionPrompt(input.categoryNames),
      [{ type: 'text', text: 'Extraia as transações deste documento.' }, filePart],
    );
    if (parsed == null) throw BadRequest('A IA não retornou conteúdo para o documento.');
    return coerceExtraction(parsed);
  }

  async categorizeRows(input: CategorizeInput): Promise<(string | null)[]> {
    if (input.rows.length === 0) return [];

    const parsed = await this.runTool(
      'categorize',
      categorizeJsonSchema as unknown as InputSchema,
      buildCategorizePrompt(input.categoryNames),
      [
        {
          type: 'text',
          text: JSON.stringify(
            input.rows.map((r, i) => ({ index: i, description: r.description, type: r.type })),
          ),
        },
      ],
    );
    return coerceCategories(input.rows.length, parsed);
  }
}
