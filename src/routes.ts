import type { FastifyInstance } from 'fastify';
import { resolveWorkspace } from './plugins/workspace';

import authRoutes from './modules/auth/auth.routes';
import workspacesTopRoutes from './modules/workspaces/workspaces.routes';
import invitationAcceptRoutes from './modules/invitations/accept.routes';
import workspaceScopedRoutes from './modules/workspaces/scoped.routes';
import membersRoutes from './modules/members/members.routes';
import invitationsScopedRoutes from './modules/invitations/invitations.routes';
import institutionsRoutes from './modules/institutions/institutions.routes';
import accountsRoutes from './modules/accounts/accounts.routes';
import cardsRoutes from './modules/cards/cards.routes';
import categoriesRoutes from './modules/categories/categories.routes';
import tagsRoutes from './modules/tags/tags.routes';
import transactionsRoutes from './modules/transactions/transactions.routes';
import attachmentsRoutes from './modules/attachments/attachments.routes';
import budgetsRoutes from './modules/budgets/budgets.routes';
import recurringRoutes from './modules/recurring/recurring.routes';
import installmentsRoutes from './modules/installments/installments.routes';
import invoicesRoutes from './modules/invoices/invoices.routes';
import investmentsRoutes from './modules/investments/investments.routes';
import syncRoutes from './modules/sync/sync.routes';
import forecastRoutes from './modules/forecast/forecast.routes';
import activityRoutes from './modules/activity/activity.routes';
import importsRoutes from './modules/imports/imports.routes';

/** Registra toda a árvore de rotas da API (montada sob /api pelo servidor). */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.register(authRoutes, { prefix: '/auth' });
  app.register(workspacesTopRoutes, { prefix: '/workspaces' });
  app.register(invitationAcceptRoutes, { prefix: '/invitations' });

  // Grupo escopado: tudo aqui exige autenticação + ser membro do workspace.
  app.register(
    async (scoped) => {
      scoped.addHook('preHandler', scoped.authenticate);
      scoped.addHook('preHandler', resolveWorkspace);

      scoped.register(workspaceScopedRoutes);
      scoped.register(membersRoutes, { prefix: '/members' });
      scoped.register(invitationsScopedRoutes, { prefix: '/invitations' });
      scoped.register(institutionsRoutes, { prefix: '/institutions' });
      scoped.register(accountsRoutes, { prefix: '/accounts' });
      scoped.register(cardsRoutes, { prefix: '/cards' });
      scoped.register(categoriesRoutes, { prefix: '/categories' });
      scoped.register(tagsRoutes, { prefix: '/tags' });
      scoped.register(transactionsRoutes, { prefix: '/transactions' });
      scoped.register(attachmentsRoutes, { prefix: '/transactions/:transactionId/attachments' });
      scoped.register(budgetsRoutes, { prefix: '/budgets' });
      scoped.register(recurringRoutes, { prefix: '/recurring' });
      scoped.register(installmentsRoutes, { prefix: '/installments' });
      scoped.register(invoicesRoutes, { prefix: '/invoices' });
      scoped.register(investmentsRoutes, { prefix: '/investments' });
      scoped.register(syncRoutes, { prefix: '/sync' });
      scoped.register(forecastRoutes, { prefix: '/forecast' });
      scoped.register(activityRoutes, { prefix: '/activity' });
      scoped.register(importsRoutes, { prefix: '/imports' });
    },
    { prefix: '/workspaces/:workspaceId' },
  );
}
