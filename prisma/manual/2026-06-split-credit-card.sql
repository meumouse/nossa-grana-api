-- ============================================================================
--  Migração de dados: Cartão de crédito vira entidade SEPARADA (CreditCard)
-- ----------------------------------------------------------------------------
--  Use SOMENTE se já existirem dados reais (Account.type = 'CREDIT_CARD').
--  Sem dados de cartão, basta `prisma db push` (o schema novo é criado direto).
--
--  Como o fluxo do projeto é `prisma db push` (sem migrations versionadas), a
--  remoção do valor de enum CREDIT_CARD e das colunas de cartão em Account é
--  DESTRUTIVA. Rode este script em DUAS FASES para preservar os dados:
--
--  FASE A (schema ADITIVO — antes de remover nada):
--    1. Num checkout do schema ANTERIOR, adicione APENAS as novidades aditivas:
--       - model CreditCard
--       - Transaction.creditCardId, Transaction.counterCreditCardId
--       - CreditCardInvoice.creditCardId (nullable temporariamente)
--       Mantenha por enquanto: AccountType.CREDIT_CARD, os campos de cartão em
--       Account e CreditCardInvoice.accountId.
--    2. `npx prisma db push`  (não destrutivo)
--    3. Rode este SQL (move os dados).
--
--  FASE B (schema FINAL — este commit):
--    4. `npx prisma db push --accept-data-loss`
--       (remove CREDIT_CARD do enum, os campos de cartão de Account e
--        CreditCardInvoice.accountId — já sem dados, é seguro)
-- ============================================================================

BEGIN;

-- 1) Cria um CreditCard por conta CREDIT_CARD, REUSANDO o mesmo id — assim as
--    transações e faturas que já apontam para esse id continuam válidas.
INSERT INTO "CreditCard" (
  id, "clientId", "workspaceId", "institutionId", name, currency, "iconColor",
  archived, "sortOrder", "creditLimit", "statementClosingDay", "paymentDueDay",
  "lateInterestRate", "paymentAccountId", "createdAt", "updatedAt", "deletedAt"
)
SELECT
  id, "clientId", "workspaceId", "institutionId", name, currency, "iconColor",
  archived, "sortOrder", "creditLimit", "statementClosingDay", "paymentDueDay",
  "lateInterestRate", "paymentAccountId", "createdAt", "updatedAt", "deletedAt"
FROM "Account"
WHERE type = 'CREDIT_CARD'
ON CONFLICT (id) DO NOTHING;

-- 2) Transações: o dono que apontava para um cartão passa a usar creditCardId.
UPDATE "Transaction" t
SET "creditCardId" = t."accountId", "accountId" = NULL
WHERE t."accountId" IN (SELECT id FROM "CreditCard");

UPDATE "Transaction" t
SET "counterCreditCardId" = t."counterAccountId", "counterAccountId" = NULL
WHERE t."counterAccountId" IN (SELECT id FROM "CreditCard");

-- 3) Faturas: copia o vínculo antigo (accountId) para o novo (creditCardId).
--    Só roda se a coluna antiga ainda existir (fase aditiva).
UPDATE "CreditCardInvoice" i
SET "creditCardId" = i."accountId"
WHERE i."creditCardId" IS NULL
  AND i."accountId" IN (SELECT id FROM "CreditCard");

-- 4) Remove as contas que viraram cartão (o id agora vive em CreditCard).
DELETE FROM "Account" WHERE type = 'CREDIT_CARD';

COMMIT;
