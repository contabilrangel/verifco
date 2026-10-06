# Arquitetura e convenções do Verifco

## Visão geral

```
verifco/
├── apps/
│   ├── api/        API HTTP (Fastify 5 + Drizzle ORM + PostgreSQL/PGlite)
│   └── web/        Aplicação web (React 19 + Vite + React Router + TanStack Query)
├── packages/
│   └── shared/     Regras de domínio compartilhadas: permissões, status, validações,
│                   templates, cálculos tributários (análise de caixa, IRPFM, holding)
├── brand/          Logo (SVG) e gerador
└── docs/           Especificação, levantamento e esta documentação
```

Monorepo pnpm. Node 22+. TypeScript estrito em tudo. Textos de interface e comentários em
português do Brasil; identificadores de código em inglês.

## Comandos

```bash
pnpm install
pnpm dev            # API em :3333 e web em :5173 (a web faz proxy de /api)
pnpm test           # testes de todos os pacotes
pnpm typecheck
pnpm --filter @verifco/api db:generate   # gera migração SQL a partir do schema.ts
```

Sem `DATABASE_URL`, a API usa o PGlite (PostgreSQL embutido) em `.data/pglite`; com
`DATABASE_URL=postgres://...`, um PostgreSQL. Em ambos os casos o banco é atualizado pelas
migrações de `apps/api/drizzle/`: **sempre que mudar o `schema.ts`, rode `pnpm db:generate`
e faça commit da migração** (a CI confere com `db:check`). Os testes usam PGlite em memória
sincronizado direto do `schema.ts`.

## API (`apps/api`)

### Módulos

Cada pasta em `src/modules/<nome>/` é um módulo carregado automaticamente:

- `routes.ts`: exporta um plugin Fastify (`export async function <nome>Routes(app)`); as rotas
  ficam sob `/api`.
- `jobs.ts` (opcional): exporta `registerJobs(ctx)` para registrar executores da fila.

Não há registro central para editar: criar a pasta basta.

### Regras obrigatórias em toda rota

1. **Autenticação e permissão**: `{ preHandler: guard('perm.chave') }` ou
   `requirePermission(req, 'perm.chave')`. As chaves estão em
   `packages/shared/src/permissions.ts`; acrescente lá se precisar de uma nova.
2. **Isolamento por escritório**: toda consulta filtra por `officeId` do usuário
   (`requireUser(req).officeId`). Para clientes, use `getCustomerForUser(ctx, user, id)` e
   `customerScope(ctx, user)` (respeitam a restrição "contadores veem só seus clientes").
3. **Validação**: `parse(zodSchema, req.body)`; erros viram 400 com a lista de campos.
4. **Erros**: lance `badRequest`, `notFound`, `conflict`, `forbidden` (`lib/errors.ts`).
5. **Auditoria**: ações relevantes chamam `audit(req, acao, entidade, id, dados)`.
6. **Segredos**: senhas e chaves só cifradas (`ctx.secrets.encrypt`) e nunca devolvidas.
7. **Dinheiro**: sempre em centavos (inteiro). Datas sem hora em `AAAA-MM-DD`. "Hoje" é o dia de
   Brasília: `todayIso()` e `addDaysIso()` de `@verifco/shared` (nunca `toISOString().slice(0, 10)`
   nem dias somados em milissegundos; `packages/shared/test/dates.test.ts` recusa o padrão), e data
   com hora gerada no servidor com `formatDateTimeBr()`.

### Serviços compartilhados (`src/services/`)

| Serviço | Uso |
| --- | --- |
| `customers.ts` | `customerScope`, `getCustomerForUser`, `publicCustomer` |
| `declarations.ts` | `getOrCreateDeclaration`, `setDeclarationSubstatus`, `advanceDeclaration`, `recomputeTotals`, `listItems`; regras únicas de status: `changeSubstatus` (troca manual, com a permissão de finalizar e a situação eCAC), `syncDeclarationStage` (transmissão e situação eCAC), `syncSubstatus` ("Documentos faltantes"); `refreshDeclaration` (totais e saldo de caixa depois de mudar linhas ou outros gastos). Aceitam o banco ou uma transação aberta (`DbOrTx`; `refreshDeclaration` recebe `{ db }`) |
| `delivery.ts` | `queueDelivery` (e-mail/WhatsApp por template ou texto, com idempotência e anexos); `createDeliveryBatch` (mala direta: envios, mensagens e jobs gravados em lote). O texto do WhatsApp sai de `htmlToText` (`packages/shared`), o mesmo da prévia e dos PDFs; para montar HTML, use `escapeHtml` de lá |
| `plan.ts` | contratos vigentes (`planStatus`, `activeContracts`), limite de declarações por exercício (aplicado em `getOrCreateDeclaration`) e modo só consulta com o contrato vencido (hook em `app.ts`) |
| `pdf.ts` | `PdfBuilder` + `loadBranding` (logo e cores do escritório) |
| `xlsx.ts` | `buildWorkbook`, `readSheet` (.xlsx, .csv e .txt), `sheetMoneyToCents`, `parseMoneyToCents`, `parseDate`, `decodeCsvText` (CSV/TXT em UTF-8 ou Windows-1252). Valor em reais de planilha sai de `SheetRow.numbers`/`sheetMoneyToCents` (no .xlsx, o texto de célula numérica usa ponto decimal: "104.895" é R$ 104,90); `parseMoneyToCents` só para texto digitado |
| `settings.ts` | `getOfficeSettings` com os padrões aplicados |
| `notify.ts` | notificação no sino |
| `uploads.ts` | `readUploads` (multipart: tipo pela extensão conferida com o conteúdo, limites por arquivo e pela soma do envio, mensagens em português; `firstFileOnly` consome e descarta os demais arquivos sem acumulá-los em memória), `sendStoredFile` (download com lista branca de tipos, `nosniff` e CSP `sandbox`; aceita stream, com `Content-Length` pelo `size`), `safeFilename`, `safeZipName`, `uploadedFromBase64`, listas de tipos (`DOCUMENT_TYPES`, `SHEET_TYPES`, `PDF_TYPES`...) |
| `rate-limit.ts` | limite de tentativas no banco (vale entre instâncias): `consume`, `check`, `fail`, `allow`, `resetLimit`; `ROUTE_LIMITS` (por IP, aplicado em `app.ts`) e as regras por e-mail, CPF/link (`CUSTOMER_LOGIN_RULE`) e conta |

**Arquivos**: todo upload usa `readUploads` (ou um leitor do módulo construído sobre ele, como
`readChecklistUploads` e `readMultipart`) e todo download de arquivo gravado usa
`sendStoredFile`. Nunca grave nem devolva o `Content-Type` informado por quem enviou.
Downloads saem em stream: `ctx.files.open(officeId, fileId)` e `sendStoredFile(reply, row, stream)`
(o `ctx.files.get`, com o arquivo inteiro na memória, fica para arquivos pequenos como logo e
anexos; o `readFile` recusa acima de 2 GiB). Um .zip montado na hora para download usa
`zipStoredFiles` (`storage/zip.ts`), que lê um arquivo de cada vez enquanto o navegador baixa,
com teto `MAX_ZIP_DOWNLOAD_BYTES` (1 GB) conferido antes; um arquivo grande gerado no servidor
(ex.: o backup) usa `ZipWriter` + `ctx.files.saveStream`, que grava em stream e calcula tamanho e
sha256 no caminho. `files.size` é `bigint` (modo number).
**Documentos de declaração**: quem grava, apaga ou muda a categoria de um documento com
`declarationId` chama `refreshElaborationStatus(db, declarationId)` (`modules/elaboration/service.ts`):
a central de elaboração lista a situação e os contadores gravados na declaração, sem ler os documentos.
**Limites de tentativa**: use as funções de `rate-limit.ts` (nunca um contador em memória, que
vale só para uma instância da API).

Contexto (`app.ctx`): `db`, `config`, `secrets`, `files` (salvar/ler arquivos), `jobs`
(fila), `providers` (e-mail, WhatsApp, IA, `fetch` injetável).

### Fila de tarefas

`ctx.jobs.enqueue(tipo, payload, { officeId, idempotencyKey })`. Tudo que fala com serviço
externo ou demora (envios, exportações, IA, sincronizações) passa pela fila. Nos testes,
`await env.ctx.jobs.drain()` executa o que estiver pendente.

- **Execução**: cada instância com `RUN_WORKER` executa até `JOB_CONCURRENCY` jobs ao mesmo tempo
  (padrão 4). Prioridade, tentativas e limites de cada tipo ficam em `src/jobs/policies.ts`:
  envios e cobranças saem primeiro; tarefas longas (`heavy`: backup, eCAC do escritório, elaboração,
  Radar) têm limite por escritório (`perOffice`) e nunca ocupam a última vaga do worker. O módulo
  completa no `ctx.jobs.register(tipo, executor, { onFailed, ... })`.
- **Lease**: o job em execução renova `locked_at` (a cada 30 s e no `progress`); se o processo cai,
  outro worker o retoma quando o lease (5 min) vence, contando a tentativa, ou o marca como falho
  se acabaram as tentativas. Ao desligar, `ctx.jobs.stop({ graceMs })` espera os jobs em andamento e
  devolve à fila os que não terminam no prazo.
- **"Já em andamento"**: deduplique com `activeJob()` (SQL) ou `isJobActive(job)`, nunca com
  `status in ('queued', 'running')`: um job de processo que caiu, sem tentativas, não pode segurar
  o botão para sempre.
- **Nova tentativa**: `enqueue` com a mesma `idempotencyKey` reabre o job que falhou de vez;
  `ctx.jobs.retryNow(tipo, [{ idempotencyKey, payload }])` atende "tentar de novo agora" (reabre
  também o concluído e antecipa o que espera nova tentativa). Erro que repetir não resolve
  (credencial recusada, integração desligada) é `PermanentJobError`: falha na hora. `onFailed` roda
  uma vez na falha final (avise o escritório por ali).
- **Fan-out**: um lote grande vira um job por item. O executor do pai cria os filhos de uma vez com
  `spawn([...])` (chave por filho) e devolve `WAIT_FOR_CHILDREN`; sem ocupar o worker, o pai roda de
  novo quando todos terminam e junta os resultados com `children()` (veja `elaboration.process`).

### Banco

`src/db/schema.ts` concentra as tabelas. Depois de alterá-lo, gere a migração
(`pnpm db:generate`) e não edite arquivos em `drizzle/` à mão. SQL de dados (ex.: um `UPDATE` de
preenchimento) vai numa migração própria, criada com
`npx drizzle-kit generate --custom --name <nome>` dentro de `apps/api` (veja
`0003_checklist_validade_links.sql`). `test/migrations.test.ts` confere que as migrações aplicam
num banco vazio e chegam ao mesmo banco que o `schema.ts`.

Escritas que dependem umas das outras vão numa `db.transaction`; quando duas requisições podem
disputar a mesma declaração, a transação começa travando a linha dela
(`select ... from declarations where id = ... for update`) e relê os dados já sob a trava. Dentro
da transação, use só o `tx` (e funções que aceitam `DbOrTx`): no PGlite, uma consulta pelo `db`
espera a transação terminar e a requisição fica parada. Arquivos (`ctx.files`) são apagados só
depois do commit.

### Testes

Vitest com PGlite em memória e provedores falsos (`test/helpers.ts`):
`createTestEnv()`, `registerOffice(env)` (devolve `api` autenticado), `createEmployee(env, api, perms)`,
`VALID_CPFS`. `env.providers.sentEmails`/`sentWhatsApp` mostram o que foi enviado.
Cada módulo tem o seu arquivo `test/<modulo>.test.ts` cobrindo regras de negócio,
permissões e isolamento entre escritórios.

### Implantação

- `NODE_ENV=production` (o `pnpm start` já define): a API recusa subir sem `JWT_SECRET` (32+
  caracteres), `ENCRYPTION_KEY` e `DATABASE_URL` de PostgreSQL. Modelo em `apps/api/.env.example`.
- **Atrás de proxy reverso ou balanceador (nginx, Caddy, Traefik, load balancer da nuvem),
  `TRUST_PROXY=1` é obrigatório** (o número de proxies na frente da API; com dois, `2`). Pelo
  número, a API só confia no proxy da frente quando ele conecta por rede interna (127.x, 10.x,
  172.16–31.x, 192.168.x, link-local, fc00::/7); se ele chega por IP público, use a lista de
  IPs/CIDRs dos proxies (`TRUST_PROXY=10.0.0.0/8,192.168.1.10`), e a API avisa no console quando
  ignora o cabeçalho por isso. O Fastify 5.12+ não aceita mais `trustProxy` numérico sozinho
  (`lib/proxy.ts` converte o número numa função que confere a conexão). Sem `TRUST_PROXY`, a API
  enxerga só o IP do proxy e o limite de tentativas por IP (login, senha, cadastro, links
  públicos) passa a valer para todos os clientes juntos: algumas senhas erradas bloqueiam o
  escritório inteiro. Em produção, a API avisa no console (uma vez) quando recebe
  `X-Forwarded-For` com `TRUST_PROXY` desligado. O proxy precisa acrescentar o IP do cliente ao
  `X-Forwarded-For`; a API usa o valor acrescentado pelo último proxy confiável e ignora o que o
  cliente mandou antes dele.
- Não use `TRUST_PROXY=true`: confia em todos os saltos, e o cliente escolhe o próprio IP no
  primeiro valor do `X-Forwarded-For` para escapar do limite (a API aceita, mas avisa no console).
- Com a API exposta direto na internet, deixe `TRUST_PROXY` desligado: o cliente poderia forjar o
  cabeçalho para escapar do limite.
- Ao subir, a API aplica as migrações de `apps/api/drizzle/` (padrão `DB_SYNC=migrate`); não use
  `DB_SYNC=push` em produção.
- **Fila de tarefas fora das instâncias HTTP (recomendado em produção)**: por padrão
  (`RUN_WORKER=true`) cada processo da API também executa a fila, e jobs pesados (backup do
  escritório, que lê todos os arquivos; exportações e processamento da elaboração; sincronizações
  do eCAC) disputam CPU, memória e disco com as requisições de todos os escritórios. Rode as
  instâncias que atendem o público com `RUN_WORKER=false` e uma instância separada com
  `RUN_WORKER=true` (o mesmo `pnpm start`, fora do balanceador), com o mesmo `DATABASE_URL` e o
  mesmo armazenamento de arquivos (`STORAGE_DIR` numa pasta compartilhada, se estiverem em máquinas
  diferentes: o worker grava o .zip do backup e a API o entrega). A geração de backup roda um de
  cada vez por processo; com um só worker, um de cada vez no total.

## Web (`apps/web`)

### Módulos

Cada pasta `src/modules/<nome>/module.tsx` exporta `module: VerifcoModule` e é carregada
automaticamente (`import.meta.glob`):

```tsx
export const module: VerifcoModule = {
  routes: [{ path: 'financeiro/metodos', element: <PaymentMethodsPage /> }],   // dentro do Shell
  publicRoutes: [{ path: '/portal', element: <PortalPage /> }],                // fora do Shell
  profileTabs: [{ path: 'irpf', label: 'IRPF', icon: FileText, element: IrpfTab, order: 20 }],
};
```

Além de `routes`, `publicRoutes` e `profileTabs`, um módulo pode registrar `adminTabs`
(abas de `/admin/<path>`), `reportTabs` (abas de `/relatorios/<path>`) e `irpfSteps`
(etapas da aba IRPF do cliente, `/clientes/:id/irpf/<path>`). As páginas com abas e a aba
IRPF são montadas em `src/app/routes.tsx` e `src/app/TabbedPage.tsx`.

O menu lateral fica em `src/app/nav.ts` e já tem todos os destinos.

### Mapa de rotas, abas e etapas

| Onde | path (ordem) → módulo |
| --- | --- |
| Rotas | `''` dashboard e `kanban` → declarations · `radar`, `backup` → advisory · `clientes` → customers · `importacoes/:tipo` → imports (exceto `importacoes/orcamentos` → finance) · `financeiro/metodos`, `financeiro/tabelas` → finance · `comunicacao/*`, `ajuda` → communication · `elaboracao`, `pre-preenchidas`, `downloads` → ecac · `conta`, `conta/preferencias` → imports (conta do usuário) |
| Rotas públicas | `/portal/*`, `/checklist/:token` → checklist · `/orcamento/:token` → finance |
| Perfil do cliente | `''` Painel (10) → declarations · `irpf` (20) → núcleo · `ia` (30), `irpfm` (80), `copiloto` (85), `livro-caixa` (90) → advisory · `ecac` (40), `acoes-ecac` (45) → ecac · `identificacao` (60), `endereco` (70) → customers · `mensagens` (95) → checklist |
| Etapas IRPF | `orcamento` (10) → finance · `declaracao` (20), `darf` (40), `pendencias` (60), `documentos` (65) → declarations · `documentacao` (30) → checklist · `relatorios` (50) → communication · `holding` (70) → advisory |
| Administração | `empresa` (10), `preferencias` (20), `colaboradores` (30), `funcoes` (40), `grupos` (50), `procuradores` (60), `contratos` (70) → imports/admin · `integracoes` (80) → integrations · `robo` (85) → ecac · `copiloto` (90) → advisory |
| Relatórios | `faturamento` (10) → finance · `resultados` (20), `documentos-faltantes` (30), `restituicao` (40) → communication |

### Design system (`src/ds/`)

Componentes no padrão Tangram (fundações públicas do Tangram: DM Sans, escala tipográfica,
grid de 8px, raios, elevações) com o tema Verifco: `Button`, `IconButton`, `Card`, `Input`, `PasswordInput`,
`MoneyInput`, `Select`, `Textarea`, `Checkbox`, `Switch`, `Field`, `Tag`, `Alert`, `Modal`,
`Drawer`, `ConfirmDialog`, `Menu`/`MenuItem`, `Tabs`, `Loading`, `Spinner`, `EmptyState`,
`Avatar`, `Stat`, `Progress`, `Pagination`, `DropFile`, `useToast`.
Classes utilitárias: `vf-stack`, `vf-inline`, `vf-grid` (`--cols` ou `--grid-template`), `vf-span-2`/
`vf-span-3`/`vf-span-full` (ou a prop `span` dos campos; nunca `gridColumn` em linha), `vf-table`,
`vf-muted`, `vf-text-*`, `vf-kanban*`, `vf-steps`/`vf-step`, `vf-chat`/`vf-bubble`. Barras de abas
usam `TabBar` (setas e aba ativa sempre à vista).
Use os tokens CSS (`var(--color-...)`, `var(--size-spacing-..)`), nunca cores soltas.
O CSS de cada módulo fica em `modules/<nome>/<nome>.css` (importado no módulo), com classes novas
prefixadas pelo módulo (`vf-adv-`, `vf-dec-`, `vf-fin-`, `vf-ecac-`, `vf-int-`, `vf-cus-`...);
ajustes de componentes do design system só com escopo do módulo. `pnpm check:css` (também na
CI) confere a sintaxe de todo o CSS e recusa classe repetida entre módulos.

### Dados

- `useApi<T>(chave, '/caminho')` para leitura; `useAction(fn, { success, invalidate })` para
  escrita (toast e invalidação automáticos).
- `api.get/post/put/del/upload/download/open` (`src/lib/api.ts`), `qs({...})` para query string.
- `useAuth().can('perm')` esconde o que o usuário não pode fazer (o servidor também bloqueia).
- `useYear()` é o ano-exercício global da barra superior.
- `useCustomer()` dentro das abas do perfil do cliente.

### Padrões de tela

- `PageHeader` com título, descrição, breadcrumbs e ações.
- Listagens em `Card flush` com tabela `vf-table`, busca, filtros em `Drawer` à direita,
  seleção com ações em massa e `Pagination`.
- Estados: carregando (`Loading`), vazio (`EmptyState` com ação), erro (toast/`Alert`).
- Ações destrutivas ou que disparam envio pedem confirmação (`ConfirmDialog`).
