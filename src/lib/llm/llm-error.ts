import { AppError, BadRequest } from '../errors';

/**
 * Traduz um erro vindo da SDK/API de um provider de LLM em um `AppError` com
 * mensagem acionável. Sem isto, um "400 invalid model ID" da OpenAI (ou
 * equivalente) sobe até o handler global e vira um 500 "Erro interno do
 * servidor" opaco — impossível de diagnosticar pela UI. Erros já tratados
 * (`AppError`, ex.: chave ausente) passam direto sem reembrulho.
 *
 * Aceita tanto o erro cru das SDKs (que expõem `.status`) quanto um objeto
 * `{ status, message }` montado a partir de uma resposta HTTP (ex.: Gemini via
 * fetch). Sempre lança — o tipo de retorno `never` permite usá-lo em
 * `.catch(err => rethrowLlmError(err, ...))` sem alterar o tipo resolvido.
 */
export function rethrowLlmError(err: unknown, providerLabel: string): never {
  if (err instanceof AppError) throw err;

  const status =
    typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : undefined;
  const raw = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);

  if (status === 401 || status === 403) {
    throw BadRequest(`Chave de API inválida para a ${providerLabel}. Revise-a em Configurações.`);
  }
  if (status === 404 || /invalid model|model.*not.*found|model_not_found|does not exist/i.test(raw)) {
    throw BadRequest(
      `Modelo inválido para a ${providerLabel}. Revise o modelo selecionado em Configurações.`,
    );
  }
  if (status === 429) {
    throw BadRequest(
      `Limite de uso atingido na ${providerLabel}. Aguarde alguns instantes e tente novamente.`,
    );
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    throw BadRequest(`A ${providerLabel} rejeitou a requisição (${status}). ${raw.slice(0, 200)}`.trim());
  }
  throw BadRequest(`Falha ao chamar a ${providerLabel}. ${raw.slice(0, 200)}`.trim());
}
