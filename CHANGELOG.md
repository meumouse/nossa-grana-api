# Changelog

Versão 1.2.0 (23/06/2026)
* Novidades:
    - Etiquetas (tags) em recorrências e parcelamentos: o template/plano guarda as etiquetas e as propaga a cada ocorrência/parcela materializada (inclusive ao regenerar parcelas e ao estender o horizonte de recorrências)
* Requer `npx prisma db push` (novas relações N:N `RecurringTransaction`↔`Tag` e `InstallmentPlan`↔`Tag`)

Versão 1.1.0 (23/06/2026)
* Novidades:
    - Etiquetas (tags) nos lançamentos: catálogo padrão criado por workspace, filtro por etiqueta e sincronização offline das etiquetas
    - Observações (comentários) nos lançamentos
    - Documentos grandes divididos em partes para leitura por IA (PDFs por intervalo de páginas; CSV/OFX por linhas), com acompanhamento do progresso parte a parte
    - Nova área de documentos: envio, listagem, download seguro, exclusão e reimportação por IA, com os arquivos vinculados às importações e guardados no S3
    - Instituições personalizadas: envio de logo, edição e exclusão das criadas pelo usuário
* Melhorias:
    - Cache da extração por IA por 7 dias (por conteúdo + provedor/modelo): reprocessar o mesmo documento reaproveita o resultado sem gastar tokens de novo
    - Confirmação da importação em uma única requisição, evitando o estouro do limite de taxa em lotes grandes (ex.: 600 lançamentos)

Versão 1.0.0 (22/06/2026)
* Novidades:
    - Importação de documentos por IA processada em segundo plano (fila), suportando arquivos grandes (PDFs com muitas páginas) sem travar o envio
    - Nova etapa de confirmação antes da leitura com IA: o envio apenas registra o documento (com tamanho e número de páginas) e a extração só começa após a confirmação
* Melhorias:
    - Leitura do documento separada do envio, deixando o upload mais rápido e estável
    - Reprocessamento seguro de importações que falharam, sem duplicar lançamentos

Versão 0.2.0 (21/06/2026)
* Novidades:
    - Alertas de duplicidade e verificação de consistência com IA
    - Divisão de despesas compartilhadas, vinculada aos membros do workspace
    - Login com Google e edição de perfil do usuário
    - Cartões de crédito separados das contas bancárias, como entidade própria
    - Confirmação da importação processada em segundo plano (fila)
    - Convite de membros por e-mail ou telefone
    - Detecção de séries recorrentes a partir do extrato, com criação de recorrências
    - Parcelas de cartão vinculadas a faturas futuras e previsão de parcelas de conta
    - Exclusão de faturas e de ativos de investimento
    - Edição de planos de parcelamento
    - Estorno do pagamento de um lançamento
    - Escolha de conta ou cartão na importação por IA
* Melhorias:
    - Camada de cache (em memória e Redis) para ganho de desempenho
    - Lista de modelos de IA salva por workspace
    - Categorias de receita padrão para reembolsos e dinheiro de terceiros
    - Erros do provedor de IA exibidos com mais clareza e validação do modelo
    - Sincronização passa a aceitar lançamentos originados no servidor
    - Verificação de duplicidade não sinaliza mais parcelas como duplicadas e passa a considerar mesmo valor e mesma data
    - Categorias padrão sem ícones de emoji

Versão 0.1.0 (20/06/2026)
* Novidades:
    - Primeira versão da API (extraída do monorepo)
    - Importação de extratos, comprovantes e faturas com IA, com escolha de provedor (OpenAI) e descoberta de modelos em tempo real
    - Suporte a múltiplos provedores de IA
    - Armazenamento de documentos (S3) e envio de e-mails transacionais
    - Limites de cartão e de conta bancária, além de dados bancários da conta
* Melhorias:
    - Chave de IA ilegível passa a ser tratada como "não configurada", sem quebrar as configurações
