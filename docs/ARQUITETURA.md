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

Sem `DATABASE_URL`, a API usa o PGlite (PostgreSQL embutido) em `.data/pglite` e sincroniza
o banco direto do `schema.ts`. Com `DATABASE_URL=postgres://...` usa as migrações de
`apps/api/drizzle/` (gere com `db:generate` sempre que mudar o schema).

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

`src/db/schema.ts` concentra as tabelas. Mudanças de schema são aceitas, mas prefira usar as
tabelas existentes (a maioria das entidades do levantamento já está modelada). Não edite
arquivos em `drizzle/` à mão.

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

Ordem das abas do perfil do cliente: Painel (10), IRPF (20), IA (30), eCAC (40),
Ações eCAC (45), Identificação (60), Endereço (70), IRPFM (80), Copiloto (85),
Livro caixa (90), Mensagens (95).

O menu lateral fica em `src/app/nav.ts` e já tem todos os destinos.

### Design system (`src/ds/`)

Componentes no padrão Tangram (fundações públicas do Tangram: DM Sans, escala tipográfica,
grid de 8px, raios, elevações) com o tema Verifco: `Button`, `IconButton`, `Card`, `Input`,
`MoneyInput`, `Select`, `Textarea`, `Checkbox`, `Switch`, `Field`, `Tag`, `Alert`, `Modal`,
`Drawer`, `ConfirmDialog`, `Menu`/`MenuItem`, `Tabs`, `Loading`, `Spinner`, `EmptyState`,
`Avatar`, `Stat`, `Progress`, `Pagination`, `DropFile`, `useToast`.
Classes utilitárias: `vf-stack`, `vf-inline`, `vf-grid` (`--cols`), `vf-table`, `vf-muted`,
`vf-text-*`, `vf-kanban*`, `vf-steps`/`vf-step`, `vf-chat`/`vf-bubble`.
Use os tokens CSS (`var(--color-...)`, `var(--size-spacing-..)`), nunca cores soltas.

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
