# Mapeamento funcional do ConferIR (portal.conferironline.com.br)

Levantamento feito em 06/10/2026 para servir de base ao desenvolvimento de uma plataforma
equivalente de gestão de IRPF para escritórios contábeis.

## Fontes e limites deste levantamento

- **Usado:** o site institucional público (www.conferironline.com.br) e o pacote JavaScript
  público do portal (o Angular baixado por qualquer visitante da tela de login), de onde saíram
  as rotas, o menu lateral, as permissões e os rótulos de status.
- **Não usado:** a área logada. Esta análise rodou num ambiente em nuvem, sem acesso ao navegador
  com a sessão aberta. A central de ajuda (conferir.freshdesk.com) também exige login.
- **Consequência:** o mapa abaixo mostra *quais* telas e funções existem e como estão
  organizadas, mas não traz os campos exatos de cada formulário, as regras de cálculo nem o
  comportamento detalhado. Onde o significado de uma rota foi deduzido do nome, está marcado
  como *(provável)*.

## 1. O produto

ConferIR, da Seek Web: SaaS web de gestão de IRPF para escritórios contábeis. Segundo o site,
são mais de 3.500 escritórios ativos, com usuários ilimitados e planos cobrados pelo volume de
declarações.

Proposta: centralizar a temporada de IR (documentos, pendências, status, cobrança, eCAC e
comunicação com o cliente) e transformar o IR em consultoria (patrimônio, holding,
planejamento tributário e IA).

### Planos (site público)

| Plano | Público-alvo | Preço (100 decl.) | Inclui |
|---|---|---|---|
| Básico | organização e controle | R$ 99/mês | documentos, dashboard, análise de caixa e malha fina, orçamentos, buscador de informes, eCAC e Carnê-Leão Web, mala direta, cobrança Asaas, simulação de holding |
| IA | escalar com IA | R$ 149/mês | tudo do Básico + leitura de documentos por IA, Especialista em IR, Especialista em Malha Fina, Assessor Financeiro, pré-declaração automatizada, relatórios detalhados, histórico de 5 anos, elaboração |
| IA + Elaboração | plataforma completa | R$ 299/mês | tudo do IA + elaboração completa, planejamento tributário, IRPFM, kit pós-declaração, relatório de pensão alimentícia, suporte prioritário |

As faixas de 200, 300 e ilimitado sobem os preços (de R$ 199 a R$ 599/mês). Há opção anual.

## 2. Arquitetura observada

| Peça | O que é |
|---|---|
| Portal web | SPA em **Angular** (build com esbuild, *lazy chunks*), fonte Work Sans |
| Editor rico | CKEditor 4 (templates de e-mail e mala direta) |
| Ícones | Iconify (feather, mdi, clarity, grommet-icons) |
| Onboarding | Conpass (tours guiados dentro do app) |
| Suporte | Freshdesk (base de conhecimento com links contextuais em cada tela) |
| **Extensão Chrome "ConferIR"** | automação dentro do eCAC/gov.br no navegador do contador |
| **"Sincronizador"** | aplicativo instalado localmente que sincroniza dados (provavelmente eCAC/certificado) |
| App "Portal do Cliente" | iOS e Android, para o cliente final enviar documentos e acompanhar |
| Integrações | Asaas e Omie (cobrança/financeiro), WhatsApp (há referências a Evolution API), Carnê-Leão Web, gov.br |
| IA | referências a Gemini e OpenAI no código |

## 3. Menu lateral

```
Início
├── Dashboard          /dashboard
├── Radar              /dashboard/insights
└── Kanban             /dashboard/kanban
Clientes
├── Listar Clientes            /customers
├── Novos clientes em lote     /import-spreadsheet/new-customers
├── Atualizar cliente em lote  /import-spreadsheet/update-customers
├── Orçamento em lote          /import-spreadsheet/budget
├── Procuração em lote         /import-spreadsheet/procuration
├── Login INSS em lote         /import-spreadsheet/inss
├── Central de Downloads       /downloads-center
├── Emails Enviados            /mailing
├── Templates de email         /email-templates
├── Métodos de pagamento       /payment-methods
└── Tabelas de cobrança        /price-tables
Gerador de declarações   /elaboration
Pré-preenchidas IRPF     /pre-filled-statements
Relatórios               /reports  (→ /reports/billing-report)
Backup                   /backup
Administrador            /admin
```

## 4. Módulos e telas (117 rotas no total)

### 4.1 Autenticação e conta
- `login`, `accounts/confirm` (confirmação de e-mail), `user-recovery-password`
- `accounting-offices-registration`: cadastro do escritório (*trial*)
- `account-details`: detalhes da conta, plano e assinatura
- `user-preferences`: preferências do usuário

### 4.2 Dashboard
- `dashboard`: painel com declarações em andamento, transmitidas, pendentes e com saldo
  negativo de caixa
- `dashboard/insights` **Radar**: alertas e oportunidades da carteira *(provável)*
- `dashboard/kanban`: quadro por status da declaração

**Status/etapas encontrados no código:** Iniciado · Documentação · Em Preenchimento ·
Em revisão · Aguardando validação · Pendente / Pendente, aguardando cliente · Em Processamento ·
Transmitidas · Processadas · Malha Fina · Restituição · Finalizado/Conclusão.

### 4.3 Clientes
- `customers`: lista com pesquisa, impressão de etiquetas e exclusão
- `customer-profile`, `dashboard-customer`: painel individual do cliente
- `registration-data`, `contacts`, `address`: cadastro
- `customer-group`: grupos de clientes
- `procuration`: vínculo do cliente com um procurador (procuração eletrônica no eCAC)
- `plan-customer-portal`: acesso do cliente ao Portal/App

### 4.4 Declaração IRPF do cliente (`irpf`, `init-irpf`)
As rotas seguem as fichas do programa da Receita:

| Rota | Ficha da DIRPF |
|---|---|
| `identification` | Identificação do contribuinte |
| `address-declaration` | Endereço |
| `dependents` | Dependentes |
| `incomes`, `incomes-dependents` | Rendimentos tributáveis recebidos de PJ |
| `incomes-pf-exterior`, `…-dependents` | Rendimentos de PF e do exterior |
| `incomes-exempt` | Rendimentos isentos e não tributáveis |
| `incomes-exclusive` | Tributação exclusiva/definitiva |
| `incomes-suspended` | Exigibilidade suspensa |
| `incomes-accumulated` | Rendimentos recebidos acumuladamente (RRA) |
| `paying-sources`, `…-dependents` | Fontes pagadoras |
| `payments`, `payments-dependents` | Pagamentos efetuados (dedutíveis) |
| `donations`, `donations-political` | Doações efetuadas / a partidos |
| `belongings` | Bens e direitos |
| `debit-and-charges` | Dívidas e ônus reais |
| `rural-belongings`, `rural-debts` | Atividade rural |
| `others` | Outros (ganhos de capital, outros gastos) *(provável)* |
| `cash-book-feature` | Livro-caixa / Carnê-Leão |
| `form-dirf` | Informe de rendimentos (DIRF) *(provável)* |

Rotas de fluxo e apoio da declaração:
- `documentation-irpf`: checklist de documentos solicitados e recebidos
- `backlogs`, `report-backlogs`: pendências (documentos faltantes)
- `notifications-irpf`, `messages`, `events`: avisos, mensagens e histórico
- `actions`: ações automatizadas via extensão (eCAC)
- `darf-irpf`: gestão de DARF (quotas)
- `finished`, `finished-irpf`, `post-declaration`, `kit`: conclusão e **kit pós-declaração**
- `results-report`, `report-payment-refund`, `reports-irpf`, `select-reports`,
  `schedule-reports`, `upload-reports`: relatórios do cliente (resultado, restituição,
  agendamento e envio)

### 4.5 Comercial e financeiro do serviço de IR
- `budget`, `budgets-irpf`, `approve-budget`: orçamento fixo, variável ou via Asaas/Omie, com
  aprovação pelo cliente
- `contracts`: contrato e documento de autorização
- `price-tables`: tabelas de cobrança
- `payment-methods`: métodos de pagamento
- `/reports/billing-report`: faturamento; também há geração e envio de recibos

### 4.6 eCAC e Receita
- `ecac`, `ecac-login`: credenciais e status no eCAC
- Funções citadas: status das declarações (processadas, malha), extrato de rendimentos,
  DARF, CND, status simplificado, lotes de restituição
- `/pre-filled-statements`: **pré-preenchida em lote** via gov.br
- `inss`: login INSS (extratos e informes)
- Execução por **extensão Chrome** e **Sincronizador**

### 4.7 Análises e consultoria
- `fed` *(provável: Fed/análise de caixa)*, análise de caixa, evolução patrimonial e histórico
  de 5 anos
- `ifrm`: **IRPFM**, a tributação mínima de altas rendas
- `holding`: simulador de holding
- `financial-copilot`: **Copiloto Financeiro** (Assessor Financeiro com IA)
- `ia`: Especialista em IR e Especialista em Malha Fina
- Relatório de pensão alimentícia

### 4.8 Elaboração da declaração (`/elaboration`)
"Gerador de declarações": monta a declaração na plataforma, com leitura de documentos por IA
(informes, comprovantes, escrituras). Exporta para o programa da Receita *(provável)*.

### 4.9 Comunicação
- `direct-mail`: mala direta (Checklist DIRPF em PDF e digital, Planejamento DIRPF, Marketing)
- `/email-templates`: templates em CKEditor
- `/mailing`: e-mails enviados
- WhatsApp: integração e envio de comunicados

### 4.10 Importação em lote (`/import-spreadsheet/*`)
Cada importação tem um modelo de planilha para baixar (*download*) e um envio (*upload*):
novos clientes, atualizar clientes, orçamentos, procurações, logins eCAC e logins INSS.

### 4.11 Administração do escritório
- `admin`, `settings`, `edit-accounting-office`: dados e configurações do escritório
- `employee-management`: colaboradores
- `roles`: perfis e permissões
- `integrations`: Asaas, Omie e WhatsApp
- `/backup`: backup dos dados do escritório
- `/downloads-center`: arquivos gerados em segundo plano

## 5. Permissões (RBAC)

Controle por *claims* atribuídas a perfis:

```
CUSTOMER_CREATE / CUSTOMER_LIST
ADMIN_COMPANY_EDIT
ADMIN_CUSTOMER_GROUP_CREATE / _LIST
ADMIN_EMPLOYEE_CREATE / _LIST
ADMIN_ROLE_CREATE / _LIST
ADMIN_PERMISSION_EDIT / _LIST
PAYMENT_METHOD_CREATE / _LIST
PRICING_TABLE_CREATE / _LIST
TEMPLATE_EMAIL_LIST
REPORT_FINANCIAL_REVENUES_GENERATE
REPORT_RESULTS_GENERATE
REPORT_PENDENCIES_GENERATE
BACKUP_DOWNLOAD
WORKSHEET_{CUSTOMER,UPDATE_CUSTOMER,BUDGET,PROCURATION,ECAC,INSS}_{DOWNLOAD,UPLOAD}
```

## 6. Atores

1. **Escritório**, ou seja, o tenant, com seus colaboradores e perfis.
2. **Cliente PF**: usa o Portal/App do Cliente para enviar documentos, aprovar orçamento e
   receber o kit.
3. **Procurador**: quem tem a procuração eletrônica do cliente no eCAC.

## 7. Sugestão de ordem de construção

1. Multi-tenant (escritório), autenticação, colaboradores e RBAC por *claims*
2. Cadastro de clientes, grupos e importação por planilha
3. Declaração por exercício com as fichas da DIRPF, checklist de documentos e pendências
4. Kanban/Dashboard com os status do item 4.2
5. Portal do cliente (upload de documentos e aprovação de orçamento)
6. Orçamentos, tabelas de cobrança, recibos e integração Asaas/Omie
7. Comunicação: templates, mala direta, e-mail e WhatsApp
8. eCAC: avaliar a API oficial **Integra Contador (SERPRO)** como alternativa à automação por
   extensão
9. Relatórios (caixa, evolução patrimonial, resultado, restituição), kit pós-declaração e PDFs
10. IA: leitura de documentos, especialistas, IRPFM, holding e planejamento

## 8. O que falta para fechar a especificação

Com acesso à área logada (sessão no computador do usuário) dá para registrar, tela a tela:
campos e validações de cada ficha, colunas e filtros da lista de clientes, regras de cálculo
(análise de caixa, IRPFM, holding), layout dos relatórios e do kit, e os fluxos do Portal do
Cliente.
