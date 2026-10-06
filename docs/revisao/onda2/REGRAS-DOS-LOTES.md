# Regras comuns a todos os lotes da onda 2

Projeto: monorepo Verifco (pnpm 10, Node 22). API Fastify 5 + Drizzle em `apps/api`, web React 19 em
`apps/web`, regras de domínio em `packages/shared`, extensão em `apps/extension`, sincronizador em `apps/sync`.

1. Antes de tudo, leia `docs/ARQUITETURA.md` (convenções obrigatórias: guard/permissão, escopo por
   escritório e cliente, zod, erros, audit, segredos, dinheiro em centavos, datas `AAAA-MM-DD`,
   uploads por `readUploads`, downloads por `sendStoredFile`, limites por `rate-limit.ts`, CSS por
   módulo com prefixo, `TabBar`, nada de `gridColumn` em linha).
2. Os achados estão em `docs/revisao/review-result.json`, campo `confirmed` (por `id`: `description`,
   `fix`, `verification`). Leia o achado inteiro antes de mexer. O `fix` é a correção recomendada;
   pode melhorá-la, mas explique no relatório quando divergir.
3. Rode `pnpm install --frozen-lockfile` na raiz da sua worktree antes de compilar ou testar
   (se precisar adicionar dependência, `pnpm add` no pacote certo e faça commit do lockfile).
4. Estilo: textos de interface e comentários em português do Brasil, identificadores em inglês,
   mesmo padrão e densidade de comentários do código ao redor. Mensagens de erro para o usuário em
   português, sem nome técnico de campo.
5. Escopo: corrija só os achados do seu lote. Outros seis lotes trabalham em paralelo em outras
   worktrees (fila de tarefas; streaming de backup/zips; status das declarações; comunicação;
   eCAC/robô/integrações; consistência/permissões; desempenho/resíduos). Faça mudanças mínimas em
   arquivos fora da sua área e não reformate nem reorganize código que não precisa mudar, para a
   mesclagem ser simples.
6. Banco: se mudar `apps/api/src/db/schema.ts`, gere a migração com
   `cd apps/api && npx drizzle-kit generate --name <nome_curto>`; SQL de dados vai numa migração
   própria criada com `npx drizzle-kit generate --custom --name <nome>`. Nunca edite `drizzle/` à mão
   (exceto o conteúdo do arquivo `--custom`). As migrações dos lotes serão renumeradas na mesclagem,
   então descreva no relatório cada mudança de schema e cada SQL de dados.
7. Testes: todo achado corrigido ganha teste de regressão (API em `apps/api/test/<modulo>.test.ts`,
   regras em `packages/shared/test`, web com vitest em `apps/web/src/**/*.test.tsx`). Nunca pule,
   desative ou enfraqueça teste existente; se um teste antigo precisar mudar por causa da regra nova,
   explique. A máquina tem 4 CPUs compartilhadas com os outros lotes: durante o desenvolvimento rode
   só os arquivos afetados (`cd apps/api && npx vitest run test/x.test.ts`); a suíte inteira só no fim.
8. Quando parte de uma correção for inviável aqui (formato de arquivo não público, dado oficial que
   você não consegue obter e conferir, página externa cujo HTML você não tem), não invente: faça a
   parte viável, corrija os textos da interface que prometem o que não existe e explique no relatório.
9. Verificações finais obrigatórias, todas verdes, depois do commit:
   - `pnpm typecheck`
   - `cd apps/api && npx vitest run` (suíte inteira)
   - `cd packages/shared && npx vitest run`
   - `cd apps/web && npx vitest run` e `pnpm check:css` e `pnpm --filter @verifco/web build`
   - `pnpm --filter @verifco/api db:check` (precisa da worktree limpa; roda depois do commit)
   - `git status` limpo.
10. Commit (sem push) na branch da sua worktree, mensagem em português no estilo do repositório:
    título curto e uma linha ou tópico por achado (`- INT-1: ...`), terminando com estas duas linhas:
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
    `Claude-Session: https://claude.ai/code/session_01ECPFeC4MJZxM9zmKh4M2Ks`
    Pode fazer mais de um commit. Não inclua nome de modelo em código ou comentários.
11. Relatório final (em português, é o que volta para quem coordena): caminho da worktree, nome da
    branch e hashes dos commits; por achado, o que foi feito, arquivos e testes; o que não foi feito
    e por quê; mudanças de schema e SQL de dados; dependências novas; saída resumida de cada
    verificação do item 9; riscos de conflito com os outros lotes (arquivos compartilhados que você
    tocou).
