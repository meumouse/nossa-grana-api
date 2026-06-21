import type { FastifyInstance } from 'fastify';
import type { WorkspaceSettings } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../env';
import { BadRequest, NotFound } from '../../lib/errors';
import {
  envApiKeyFor,
  isLlmProvider,
  listProviderModels,
  type LlmProvider,
} from '../../lib/llm';
import { decryptSecret, encryptSecret } from '../../lib/secrets';
import { requireRole } from '../../plugins/workspace';

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  iconColor: z.string().max(20).optional(),
});

const providerEnum = z.enum(['openai', 'anthropic', 'google']);

// IDs de modelo só têm letras, dígitos e `. - _ : /` (ex.: gpt-4o,
// claude-opus-4-8, gemini-2.5-flash, ft:gpt-4o:org::id). Rejeita lixo como
// e-mail colado por engano no campo (o `@` não casa), que faria a API do
// provider responder "invalid model ID" e derrubaria a importação.
const MODEL_ID_RE = /^[a-zA-Z0-9._:/-]+$/;

const settingsSchema = z.object({
  baseCurrency: z.string().length(3).optional(),
  monthStartDay: z.number().int().min(1).max(28).optional(),
  forecastHorizon: z.number().int().min(1).max(36).optional(),
  variableLookback: z.number().int().min(1).max(12).optional(),
  weekStartsOnMonday: z.boolean().optional(),
  // Importação por IA. String vazia limpa o campo (volta ao default de env).
  llmProvider: providerEnum.optional(),
  llmModel: z.string().max(80).optional(),
  llmApiKey: z.string().max(300).optional(),
});

// Busca de modelos: o provider/chave podem vir do corpo (ainda não salvos),
// senão caímos nas settings do workspace e, por fim, no default de env.
const llmModelsSchema = z.object({
  provider: providerEnum.optional(),
  apiKey: z.string().max(300).optional(),
});

/** Remove a chave crua da resposta; expõe só se está configurada e legível. */
function publicSettings(settings: WorkspaceSettings | null) {
  if (!settings) return null;
  const { llmApiKey, ...rest } = settings;
  // Só consideramos configurada se a chave também for decifrável: se o segredo
  // de cifragem mudou, o valor guardado vira lixo e precisa ser redigitado —
  // mostrar "Configurada" nesse caso confunde o usuário.
  return { ...rest, llmApiKeySet: Boolean(decryptSecret(llmApiKey)) };
}

/**
 * Rotas escopadas ao workspace ativo: detalhe, atualização, exclusão e settings.
 * Montadas dentro do grupo que já roda authenticate + resolveWorkspace.
 */
export default async function workspaceScopedRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request) => {
    const ws = await app.prisma.workspace.findFirst({
      where: { id: request.workspace!.id, deletedAt: null },
      include: { settings: true, _count: { select: { members: true } } },
    });
    if (!ws) throw NotFound('Workspace não encontrado');
    return { workspace: ws, role: request.workspace!.role };
  });

  app.patch('/', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = updateSchema.parse(request.body);
    const workspace = await app.prisma.workspace.update({
      where: { id: request.workspace!.id },
      data: body,
    });
    return { workspace };
  });

  app.delete('/', { preHandler: [requireRole('OWNER')] }, async (request, reply) => {
    await app.prisma.workspace.update({
      where: { id: request.workspace!.id },
      data: { deletedAt: new Date() },
    });
    return reply.code(204).send();
  });

  app.get('/settings', async (request) => {
    const settings = await app.prisma.workspaceSettings.findUnique({
      where: { workspaceId: request.workspace!.id },
    });
    return { settings: publicSettings(settings) };
  });

  app.patch('/settings', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const { llmApiKey, llmProvider, llmModel, ...rest } = settingsSchema.parse(request.body);

    const data: Record<string, unknown> = { ...rest };
    // Provider/modelo: string vazia → null (volta ao default de env).
    if (llmProvider !== undefined) data.llmProvider = llmProvider || null;
    if (llmModel !== undefined) {
      const model = llmModel.trim();
      if (model && !MODEL_ID_RE.test(model)) {
        throw BadRequest(
          'Modelo de LLM inválido — informe o ID do modelo (ex.: gpt-4o), sem espaços nem "@".',
        );
      }
      data.llmModel = model || null;
    }
    // Chave: vazia limpa; preenchida cifra antes de gravar. Ausente = não mexe.
    if (llmApiKey !== undefined) {
      data.llmApiKey = llmApiKey.trim() ? encryptSecret(llmApiKey.trim()) : null;
    }

    const settings = await app.prisma.workspaceSettings.upsert({
      where: { workspaceId: request.workspace!.id },
      update: data,
      create: { workspaceId: request.workspace!.id, ...data },
    });
    return { settings: publicSettings(settings) };
  });

  // Lista os modelos disponíveis no provider via API. A chave pode vir no corpo
  // (p/ testar uma que o usuário acabou de digitar e ainda não salvou), senão
  // usa a do workspace (decifrada) ou a de env. Só ADMIN, como as demais de IA.
  app.post('/settings/llm/models', { preHandler: [requireRole('ADMIN')] }, async (request) => {
    const body = llmModelsSchema.parse(request.body ?? {});
    const settings = await app.prisma.workspaceSettings.findUnique({
      where: { workspaceId: request.workspace!.id },
      select: { llmProvider: true, llmApiKey: true },
    });

    const rawProvider = body.provider || settings?.llmProvider || env.LLM_PROVIDER;
    const provider: LlmProvider = isLlmProvider(rawProvider) ? rawProvider : 'openai';

    const apiKey =
      body.apiKey?.trim() || decryptSecret(settings?.llmApiKey) || envApiKeyFor(provider);
    if (!apiKey) {
      // Se há chave gravada mas indecifrável (o segredo de cifragem mudou),
      // orienta a redigitar em vez do genérico "configure a chave".
      throw BadRequest(
        settings?.llmApiKey
          ? 'A chave de API salva não pôde ser lida (o segredo de cifragem mudou desde que ela foi salva). Digite a chave novamente para regravá-la.'
          : 'Configure a chave de API do provedor para buscar os modelos.',
      );
    }

    const models = await listProviderModels(provider, apiKey);

    // Persiste a lista p/ o seletor continuar populado após recarregar a página
    // (sem rebuscar na API). Toca só nos campos de cache — não mexe no
    // provider/modelo/chave já salvos. Guarda o provider da lista p/ não exibir
    // modelos de um provider diferente do selecionado.
    const fetchedAt = new Date();
    const cached = models.map((m) => ({ id: m.id, label: m.label ?? null }));
    await app.prisma.workspaceSettings.upsert({
      where: { workspaceId: request.workspace!.id },
      update: { llmModels: cached, llmModelsProvider: provider, llmModelsFetchedAt: fetchedAt },
      create: {
        workspaceId: request.workspace!.id,
        llmModels: cached,
        llmModelsProvider: provider,
        llmModelsFetchedAt: fetchedAt,
      },
    });

    return { provider, models, fetchedAt: fetchedAt.toISOString() };
  });
}
