/**
 * JSON Schemas (Structured Outputs) e prompts em PT-BR usados na extração.
 * Ficam separados do provider p/ poderem ser reaproveitados por outras
 * implementações (Claude, Gemini...) sem reescrever as instruções.
 */
import type { ConsistencyKind } from './types';

/** Schema da resposta de extração de documento (strict — todo campo é required). */
export const extractionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detectedCurrency: {
      type: ['string', 'null'],
      description: 'Código ISO da moeda detectada (ex.: BRL). null se incerto.',
    },
    notes: {
      type: ['string', 'null'],
      description: 'Observações curtas sobre a extração (ex.: páginas ilegíveis). null se nada.',
    },
    items: {
      type: 'array',
      description: 'Uma entrada por transação/lançamento encontrado no documento.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', description: 'Data ISO yyyy-mm-dd.' },
          description: { type: 'string', description: 'Descrição/estabelecimento da transação.' },
          amount: { type: 'number', description: 'Valor absoluto, sempre positivo.' },
          type: {
            type: 'string',
            enum: ['INCOME', 'EXPENSE'],
            description: 'INCOME p/ entradas/créditos; EXPENSE p/ saídas/débitos.',
          },
          suggestedCategory: {
            type: ['string', 'null'],
            description: 'Categoria sugerida (preferir uma das fornecidas). null se incerto.',
          },
          confidence: {
            type: ['number', 'null'],
            description: 'Confiança 0..1 na extração desta linha.',
          },
        },
        required: ['date', 'description', 'amount', 'type', 'suggestedCategory', 'confidence'],
      },
    },
  },
  required: ['items', 'detectedCurrency', 'notes'],
} as const;

/** Schema da resposta de categorização (CSV/OFX já parseados). */
export const categorizeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    categories: {
      type: 'array',
      description: 'Categoria sugerida para cada linha, NA MESMA ORDEM da entrada. null se incerto.',
      items: { type: ['string', 'null'] },
    },
  },
  required: ['categories'],
} as const;

/** Schema da resposta de análise de inconsistências (strict). */
export const analysisJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      description: 'Uma entrada por inconsistência encontrada. Vazio se nada suspeito.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: ['DUPLICATE', 'CATEGORY', 'AMOUNT'],
            description: 'DUPLICATE = possível duplicata; CATEGORY = categoria suspeita; AMOUNT = valor atípico/erro.',
          },
          severity: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Gravidade/confiança do achado.',
          },
          title: { type: 'string', description: 'Resumo curto do problema.' },
          detail: { type: 'string', description: 'Explicação objetiva do porquê é suspeito.' },
          suggestion: {
            type: ['string', 'null'],
            description: 'Ação sugerida (ex.: "remover a duplicata", "recategorizar"). null se não houver.',
          },
          transactionIndices: {
            type: 'array',
            description: 'Índices (campo "index" da entrada) das transações envolvidas.',
            items: { type: 'integer' },
          },
        },
        required: ['kind', 'severity', 'title', 'detail', 'suggestion', 'transactionIndices'],
      },
    },
  },
  required: ['findings'],
} as const;

function checksHint(checks: ConsistencyKind[]): string {
  const labels: Record<ConsistencyKind, string> = {
    DUPLICATE:
      'DUPLICATE: lançamentos que parecem a MESMA transação lançada em duplicidade — exige valor praticamente igual, datas muito próximas (poucos dias) E mesma contraparte/descrição. NÃO sinalize: parcelas (descrições com marcador "(n/total)", ex.: "(3/10)"), assinaturas/mensalidades recorrentes, nem compras repetidas legítimas com a mesma pessoa/serviço quando os valores ou as datas diferem. Valores diferentes para a mesma pessoa NÃO são duplicata.',
    CATEGORY:
      'CATEGORY: transações cuja categoria parece incoerente com a descrição (ex.: "Uber" categorizado como Alimentação).',
    AMOUNT:
      'AMOUNT: valores destoantes/atípicos para o estabelecimento, possíveis erros de digitação (casa decimal trocada) ou cobranças que parecem indevidas.',
  };
  return checks.map((c) => `- ${labels[c]}`).join('\n');
}

/** Instruções p/ analisar o extrato em busca de inconsistências. */
export function buildAnalysisPrompt(checks: ConsistencyKind[], categoryNames?: string[]): string {
  return [
    'Você é um auditor financeiro que revisa um extrato de transações em português do Brasil.',
    'Receberá um array JSON de transações, cada uma com: index, date (yyyy-mm-dd), description, amount (positivo), type (INCOME/EXPENSE) e category.',
    'Procure SOMENTE pelos tipos de inconsistência abaixo:',
    checksHint(checks),
    '',
    'Regras:',
    '- Use o campo "index" de cada transação para referenciá-la em "transactionIndices".',
    '- Para duplicatas, inclua TODAS as transações do grupo suspeito em "transactionIndices".',
    '- Seja conservador: só reporte quando houver evidência clara. É melhor não reportar do que gerar falso alarme.',
    '- Mensagens curtas, diretas e em português. Não invente transações que não estão na lista.',
    categoryNames && categoryNames.length
      ? `- Categorias existentes do usuário: ${categoryNames.join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function categoryHint(categoryNames?: string[]): string {
  if (!categoryNames || categoryNames.length === 0) {
    return 'O workspace ainda não tem categorias; sugira nomes curtos e genéricos em português.';
  }
  return `Use preferencialmente uma destas categorias do usuário (ou null se nenhuma servir): ${categoryNames.join(', ')}.`;
}

/** Instruções p/ extrair transações de um extrato/fatura/comprovante. */
export function buildExtractionPrompt(categoryNames?: string[]): string {
  return [
    'Você é um assistente que extrai transações financeiras de documentos brasileiros',
    '(extratos bancários, faturas de cartão, comprovantes e cupons).',
    '',
    'Regras:',
    '- Extraia TODAS as transações reais do documento, uma por linha.',
    '- Datas no formato ISO yyyy-mm-dd. Converta de dd/mm/aaaa quando necessário.',
    '- "amount" é sempre POSITIVO. O sinal vai no "type": EXPENSE para débitos/saídas/compras, INCOME para créditos/entradas/recebimentos.',
    '- Valores em formato BR (1.234,56) devem virar número (1234.56).',
    '- IGNORE linhas de saldo, totais, subtotais, juros informativos, cabeçalhos e rodapés que não sejam lançamentos.',
    '- Em comprovantes/cupons normalmente há UMA transação (a do pagamento).',
    '- Descrição: nome do estabelecimento/contraparte, limpa e legível.',
    `- ${categoryHint(categoryNames)}`,
    '- Se algo estiver ilegível, registre em "notes" e siga com o que for possível.',
    '- Não invente transações que não estão no documento.',
  ].join('\n');
}

/** Instruções p/ categorizar linhas já parseadas (sem reler o documento). */
export function buildCategorizePrompt(categoryNames: string[]): string {
  return [
    'Você categoriza transações financeiras brasileiras.',
    'Para cada linha recebida, escolha a melhor categoria.',
    categoryHint(categoryNames),
    'Responda com um array "categories" na MESMA ORDEM e com o MESMO número de itens da entrada.',
    'Use null quando nenhuma categoria servir.',
  ].join('\n');
}
