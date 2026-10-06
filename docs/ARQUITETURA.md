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

### Serviços compartilhados (`src/services/`)

| Serviço | Uso |
| --- | --- |
| `customers.ts` | `customerScope`, `getCustomerForUser`, `publicCustomer` |
| `declarations.ts` | `getOrCreateDeclaration`, `setDeclarationSubstatus`, `advanceDeclaration`, `recomputeTotals`, `listItems` |
| `delivery.ts` | `queueDelivery` (e-mail/WhatsApp por template ou texto, com idempotência e anexos) |
| `pdf.ts` | `PdfBuilder` + `loadBranding` (logo e cores do escritório) |
| `xlsx.ts` | `buildWorkbook`, `readSheet`, `parseMoneyToCents`, `parseDate` |
| `settings.ts` | `getOfficeSettings` com os padrões aplicados |
| `notify.ts` | notificação no sino |

Contexto (`app.ctx`): `db`, `config`, `secrets`, `files` (salvar/ler arquivos), `jobs`
(fila), `providers` (e-mail, WhatsApp, IA, `fetch` injetável).

### Fila de tarefas

`ctx.jobs.enqueue(tipo, payload, { officeId, idempotencyKey })`. Tudo que fala com serviço
externo ou demora (envios, exportações, IA, sincronizações) passa pela fila. Nos testes,
`await env.ctx.jobs.drain()` executa o que estiver pendente.

### Banco

`src/db/schema.ts` concentra as tabelas. Depois de alterá-lo, gere a migração
(`pnpm db:generate`) e não edite arquivos em `drizzle/` à mão.

### Testes

Vitest com PGlite em memória e provedores falsos (`test/helpers.ts`):
`createTestEnv()`, `registerOffice(env)` (devolve `api` autenticado), `createEmployee(env, api, perms)`,
`VALID_CPFS`. `env.providers.sentEmails`/`sentWhatsApp` mostram o que foi enviado.
Cada módulo tem o seu arquivo `test/<modulo>.test.ts` cobrindo regras de negócio,
permissões e isolamento entre escritórios.

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
