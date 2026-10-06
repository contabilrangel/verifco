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
7. **Dinheiro**: sempre em centavos (inteiro). Datas sem hora em `AAAA-MM-DD`.
8. **"Hoje"**: sempre no horário de Brasília, pelas funções de `packages/shared/src/dates.ts`:
   `todayIso()` (ou `brazilToday()`, a mesma), `addDaysIso(hoje, 30)` para "daqui a N dias",
   `isoDateInBrazil(instante)` para a data de um `createdAt`, `currentYearInBrazil()` para o ano e
   `formatDateTimeBr()` para "gerado em". Nunca `new Date().toISOString().slice(0, 10)` (é UTC: das
   21h à meia-noite o que vence hoje aparece vencido) nem `new Date().getFullYear()` no servidor.
   `formatDate` mostra data sem hora sem passar por fuso e data com hora no horário de Brasília.

### Serviços compartilhados (`src/services/`)

| Serviço | Uso |
| --- | --- |
| `customers.ts` | `customerScope`, `getCustomerForUser`, `publicCustomer` |
| `declarations.ts` | `getOrCreateDeclaration`, `setDeclarationSubstatus`, `advanceDeclaration`, `recomputeTotals`, `listItems` |
| `delivery.ts` | `queueDelivery` (e-mail/WhatsApp por template ou texto, com idempotência e anexos) |
| `pdf.ts` | `PdfBuilder` + `loadBranding` (logo e cores do escritório) |
| `xlsx.ts` | `buildWorkbook`; leitor único de planilhas `readSheet` (e `readSheetTable`, que devolve também os cabeçalhos) para .xlsx e .csv; `decodeCsvText` (UTF-8 ou Windows-1252 de verdade, com aspas curvas, travessão e €); `sheetMoneyToCents`, `parseMoneyToCents`, `parseDate` |
| `zip.ts` | `ZipStream` (.zip em fluxo com o `yazl`, ZIP64 automático, um arquivo aberto por vez, arquivo que sumiu fica de fora e é listado), `assertZipSize` (teto de 1 GB por download, 413) |
| `settings.ts` | `getOfficeSettings` com os padrões aplicados |
| `notify.ts` | notificação no sino |
| `uploads.ts` | `readUploads` (multipart: tipo pela extensão conferida com o conteúdo, limites por arquivo e por envio, `maxTotalBytes` padrão 150 MB, e mensagens em português), `sendStoredFile` (download com lista branca de tipos, `nosniff` e CSP `sandbox`; aceita `Buffer` ou fluxo), `safeFilename`, `safeZipName`, `uploadedFromBase64`, listas de tipos (`DOCUMENT_TYPES`, `SHEET_TYPES`, `PDF_TYPES`...) |
| `rate-limit.ts` | limite de tentativas no banco (vale entre instâncias): `consume`, `check`, `fail`, `allow`, `resetLimit`; `ROUTE_LIMITS` (por IP, aplicado em `app.ts`) e as regras por e-mail, CPF/link (`CUSTOMER_LOGIN_RULE`) e conta |

**Arquivos**: todo upload usa `readUploads` (ou um leitor do módulo construído sobre ele, como
`readChecklistUploads` e `readMultipart`) e todo download de arquivo gravado usa
`sendStoredFile`. Nunca grave nem devolva o `Content-Type` informado por quem enviou.
**Planilhas**: toda leitura de .xlsx/.csv passa por `readSheet`/`readSheetTable` (o CSV é
decodificado por `decodeCsvText`; não decodifique por conta própria nem use `TextDecoder('windows-1252')`,
que no Node 22 decodifica como Latin-1). Valor em reais de planilha sai de `sheetMoneyToCents(row, chave)`:
numa célula numérica do .xlsx ele usa o número cru de `SheetRow.numbers` (o texto da célula usa ponto
decimal, "104.895", e seria lido como R$ 104.895,00); no CSV e no texto digitado usa `parseMoneyToCents`.
`parseMoneyToCents` direto só para texto que o usuário digitou.
**Arquivos grandes** (backup, .zip, downloads de vários arquivos): leia com `ctx.files.open` e grave com
`ctx.files.saveStream` (fluxo, tamanho e SHA-256 calculados no caminho); monte .zip com `ZipStream`
(`zip.ts`), nunca com `JSZip.generateAsync` de muitos arquivos. `ctx.files.get` (Buffer) é só para
arquivos pequenos (até os 25 MB do upload).
**Limites de tentativa**: use as funções de `rate-limit.ts` (nunca um contador em memória, que
vale só para uma instância da API).

Contexto (`app.ctx`): `db`, `config`, `secrets`, `files` (salvar/ler arquivos: `save`, `get`,
`saveStream`, `open`, `remove`; `removeRows` dentro de uma transação + `deleteBlobs` depois do commit), `jobs`
(fila), `providers` (e-mail, WhatsApp, IA, `fetch` injetável).

### Fila de tarefas

`ctx.jobs.enqueue(tipo, payload, { officeId, idempotencyKey })`. Tudo que fala com serviço
externo ou demora (envios, exportações, IA, sincronizações) passa pela fila. Nos testes,
`await env.ctx.jobs.drain()` executa o que estiver pendente.

- **Posse com prazo**: o job em execução renova `locked_at` (a cada ¼ do prazo e a cada
  `progress()`). Se o processo cai (deploy, OOM), o job fica em `running` sem renovação e, vencido o
  prazo (`JOB_LEASE_SECONDS`, padrão 300), `recoverStale` o devolve à fila contando a tentativa (ou o
  marca `failed` se acabaram as tentativas). Cada execução só grava o próprio resultado enquanto
  ainda é dona do job (mesmo `attempts` e status `running`).
- **Deduplicar pedidos** ("já existe um backup em andamento"): use `ctx.jobs.pending(officeId, tipo)`,
  que recupera antes os jobs presos; não consulte `status in ('queued','running')` direto.
- **Concorrência e justiça**: cada processo roda até `JOB_CONCURRENCY` jobs (padrão 4); um escritório
  ocupa no máximo `JOB_OFFICE_CONCURRENCY` vagas (padrão `JOB_CONCURRENCY − 1`) e, havendo jobs de
  vários escritórios, eles se revezam (o 2º job do escritório A só sai depois do 1º de B e C).
  Job longo que percorre a carteira inteira deve informar `progress()`.
- **Repetição**: padrão de 3 tentativas com espera de 10 s, 20 s, 40 s... (até 10 min). Jobs que
  falam com serviço externo usam `EXTERNAL_SERVICE_RETRY` (10 tentativas: 1, 5, 15, 30 min, 1, 2, 4, 8,
  12 h). A política fica em `JOB_RETRY_POLICIES` (`jobs/queue.ts`) ou no `register(tipo, executor,
  política)`; `maxAttempts` no `enqueue` vale mais que a política.
- **Chave de idempotência**: repetir o `enqueue` com a mesma chave devolve o job que está na fila,
  rodando ou concluído; se ele **falhou de vez**, é reaberto (tentativas zeradas, payload novo).
- **Desligamento**: no SIGTERM, `server.ts` para de pegar jobs, espera os em andamento até
  `SHUTDOWN_TIMEOUT_SECONDS` (padrão 25) e devolve os que não terminaram à fila, sem gastar tentativa.

### Banco

`src/db/schema.ts` concentra as tabelas. Depois de alterá-lo, gere a migração
(`pnpm db:generate`) e não edite arquivos em `drizzle/` à mão. SQL de dados (ex.: um `UPDATE` de
preenchimento) vai numa migração própria, criada com
`npx drizzle-kit generate --custom --name <nome>` dentro de `apps/api` (veja
`0003_checklist_validade_links.sql`). `test/migrations.test.ts` confere que as migrações aplicam
num banco vazio e chegam ao mesmo banco que o `schema.ts`.
Coluna buscada por rota pública sem login (token de link, webhook) ou usada em filtro frequente
(chave estrangeira de lista, `customer_id` de envios) precisa de índice no `schema.ts`: sem ele a
busca varre a tabela de todos os escritórios.

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
- **Fila de tarefas**: cada processo com `RUN_WORKER` (padrão ligado) executa até `JOB_CONCURRENCY`
  jobs. Com várias instâncias, todas podem processar (o PostgreSQL reparte os jobs) ou a API roda com
  `RUN_WORKER=false` e um processo separado só para a fila. Pare as instâncias com SIGTERM e dê ao
  orquestrador um prazo maior que `SHUTDOWN_TIMEOUT_SECONDS` (o padrão de 25 s cabe nos 30 s do
  Docker/Kubernetes). Um job de uma instância que morreu volta para a fila em até `JOB_LEASE_SECONDS`.
- **Disco**: o backup do escritório é gravado em `STORAGE_DIR` enquanto é montado (pode passar de
  4 GB, em ZIP64); reserve espaço para ele além dos documentos.

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
grid de 8px, raios, elevações) com o tema Verifco: `Button`, `IconButton`, `Card`, `Input`,
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
