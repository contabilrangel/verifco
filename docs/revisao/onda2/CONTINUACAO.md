# Onda 2 de correções: estado na interrupção e como continuar

Este documento descreve onde a sessão parou e como retomar sem perder trabalho. Sessão
interrompida a pedido do usuário em 06/10/2026.

## Contexto

- `docs/revisao/review-result.json`: os 91 achados confirmados da revisão independente
  (campo `confirmed`, por `id`, com `description`, `fix` e `verification`).
- **Onda 1 (concluída e mesclada neste branch até `b20175e`)**: segurança, telas/CSS/CI e
  cálculos tributários. Resultado das verificações em `docs/revisao/onda1-verificacao.json`;
  todos os problemas bloqueantes foram corrigidos depois (`b9dcd31`, `5fc278b`).
- **Onda 2 (em andamento)**: os 42 achados que a onda 1 não tocou, mais as pendências não
  bloqueantes da verificação da onda 1 (OBS-1..4 e as observações de telas).
- Estado do branch na interrupção: nada da onda 2 foi mesclado no código. O código do branch
  continua igual a `b20175e`, que estava verde: `pnpm typecheck`, `pnpm check:css` (8 testes),
  shared 123 testes, web 39, API 232.

## Divisão da onda 2 em lotes

Cada lote foi feito por um agente numa worktree própria a partir de `b20175e`, seguindo
`REGRAS-DOS-LOTES.md` (nesta pasta), que traz as convenções, as verificações obrigatórias e o
formato de commit e de relatório.

| Lote | Achados | Estado na interrupção |
| --- | --- | --- |
| A, fila de tarefas | DAD-1, DAD-2 (fila e elaboration.process), DAD-4, INT-9 | Commit pronto; parou esperando a suíte completa da API (verificações finais não confirmadas) |
| B, memória e streaming | DAD-3, DAD-10 | Código pronto e revisado pelo agente; parou rodando a suíte completa **antes do commit**; salvo como commit WIP |
| C, declarações e status | INT-1, INT-6, COB-5, INT-7, INT-11, INT-13, DAD-8, DAD-16, COB-3 (parte viável), COB-6/INT-16 (avisos), DAD-5 (bulk de status) | Commit pronto; parou esperando a suíte completa da API |
| D, comunicação | INT-2, INT-5, INT-8, CON-4, CON-5, DAD-5 (mala direta e importação de orçamentos) | Commit pronto; parou no meio das verificações finais |
| E, eCAC, robô e integrações | COB-1, COB-2, COB-4, COB-6/INT-16 (autoGenerateCnd e simplifiedQueryWithoutProcurator), COB-7, COB-8, INT-15, DAD-2 (fan-out do ecac.sync_office) | Testes da web escritos; parou rodando a suíte completa da API **antes do commit** e acrescentando um cabeçalho opcional de autenticação ao webhook da Evolution (pode estar pela metade); salvo como commit WIP |
| F1, consistência e permissões | CON-7, DAD-13, CON-11, DAD-9, DAD-12, INT-17, COB-13, COB-12 | Commit pronto; parou esperando a suíte completa da API |
| F2, desempenho e resíduos | DAD-6, DAD-7, COB-9, OBS-1..4, observações de telas da onda 1 | **Mais atrasado.** Parou editando o `ItemModal` de `DeclarationStep.tsx` (OBS-4: checkbox de investimento rural), depois de fazer listagem/contadores da elaboração, índices, tabelas do Carnê-Leão e CSS. Salvo como commit WIP |

A mensagem de commit de cada patch descreve o que o lote fez, achado por achado. Os commits WIP
(B, E e F2) não têm essa descrição: leia o diff.

## Onde está o trabalho

`patches/lote-<X>/*.patch` (nesta pasta): um `git format-patch` de cada lote sobre `b20175e`.
Todos aplicam limpos sobre `b20175e` (conferido com `git apply --check`). Para recriar um lote
numa branch própria:

```bash
git switch -c onda2-lote-A b20175e
git am docs/revisao/onda2/patches/lote-A/*.patch
```

Os lotes **não** aplicam todos juntos sem conflito: cada um foi feito isolado (veja abaixo).

## Conflitos já conhecidos para a mesclagem

- **Migrações**: A (`0004_fila_prioridade_e_filhos`), B (`0004_arquivos_tamanho_bigint`), E
  (`0004_whatsapp_mensagens_recebidas` e a de dados `0005_remove_senha_inss`, que zera
  `inss_password_enc`) e F2 (`0004_indices_e_contadores_elaboracao`, talvez com preenchimento
  de contadores) geraram migrações com o mesmo número. Na mesclagem, descarte os `.sql`,
  snapshots e o `_journal.json` dos lotes, junte as mudanças de `schema.ts`, rode
  `cd apps/api && npx drizzle-kit generate --name onda2` uma vez e recrie os SQL de dados
  (`--custom`) de E (INSS) e, se houver, de F2 (contadores da elaboração), copiando o conteúdo
  dos patches. C, D e F1 não mudam o schema.
- **`apps/api/test/migrations.test.ts`**: A, B, E e F2 mexem nele (A corta o journal antes da
  0003 porque o migrator pulava a 0003 no teste; F2 mexe mais). Reconcilie à mão depois de
  renumerar.
- **`pnpm-lock.yaml` / `apps/api/package.json`**: só B adiciona dependência (biblioteca de zip
  com ZIP64). Na dúvida, rode `pnpm install` depois de mesclar.
- Arquivos editados por vários lotes (mudanças localizadas, mas com conflito provável):
  `services/declarations.ts` (C, D, F1), `finance/service.ts` (A, C, D, F1),
  `customers/routes.ts` (C, E, F1), `elaboration/routes.ts` (A, B, C, F2),
  `ecac/records.ts` (C, E, F1), `checklist/routes.ts` e `checklist/service.ts` (B, C, D, F2),
  `communication/routes.ts` (A, D), `apps/web/src/app/nav.ts` (E, F1), `ecac/util.ts` (A, E,
  F2), `imports/processors.ts` (E, F1, F2), `docs/ARQUITETURA.md` (A, B, C, F2),
  `IntegrationsPage.tsx` (E, F2), `advisory/cashbook.ts` (C, F2).
- Duplicidade a resolver: D centralizou `previousYearItems` em `checklist/service.ts`; confira
  se C ou F1 também moveram algo parecido para `services/declarations.ts`.

## Próximos passos

1. **Terminar B, E e F2** (cada um na própria branch, a partir do patch):
   - B: rodar as verificações finais e trocar o commit WIP por um commit descritivo.
   - E: conferir se o cabeçalho opcional de autenticação do webhook da Evolution ficou
     completo (ou retirá-lo), rodar as verificações finais e reescrever o commit.
   - F2: terminar o OBS-4 em `DeclarationStep.tsx`/`fichas.tsx` e conferir o resto do lote
     contra o pedido (DAD-6, DAD-7, COB-9, OBS-1..4, observações de telas). **COB-9:** o
     agente acrescentou tabelas de códigos do Carnê-Leão e a validação em `parseCashbookRow`.
     Antes de aceitar, confirme que os códigos vieram de fonte oficial da Receita e foram
     conferidos; se não houver como confirmar, retire as tabelas (a regra é não inventar dado
     oficial).
2. **Confirmar as verificações finais de A, C, D e F1** (lista no item 9 de
   `REGRAS-DOS-LOTES.md`): typecheck, as três suítes, `check:css`, build da web e `db:check`.
3. **Verificação independente de cada lote**, como na onda 1: ler o diff inteiro, conferir
   achado por achado contra o `fix` e a `verification` do `review-result.json`, procurar
   regressões (permissões a mais ou a menos, texto em inglês, tela quebrada) e corrigir o que
   faltar. Registrar o resultado em `docs/revisao/onda2-verificacao.json`, no formato de
   `onda1-verificacao.json`.
4. **Mesclar** no branch `llypedev/fervent-franklin-qcc0y1`, um lote por vez (ordem sugerida:
   A, B, C, D, F1, E, F2), resolvendo os conflitos acima e gerando uma migração única.
5. **CI local completa** no resultado da mesclagem: `pnpm install --frozen-lockfile`,
   `pnpm --filter @verifco/api db:check`, `pnpm typecheck`, `pnpm check:css`,
   `pnpm --filter @verifco/web build`, `pnpm test`. Depois, commit e push.
6. Apagar esta pasta `onda2/` (ou só `patches/`) depois que tudo estiver mesclado.

## O que fica pendente por decisão, não por falta de tempo

- **COB-3**: o leitor de .DEC/XML do programa IRPF não foi escrito, porque o leiaute não é
  público e não há arquivos reais para validar. Foi feita só a parte viável: o .REC marca a
  declaração como transmitida, e os textos deixaram de prometer a leitura.
- **COB-4**: a exportação .DBK não foi feita (formato não público, e um .DBK errado restaurado
  no programa é risco maior). A tela já avisa que o pacote não é .DBK.
- **COB-1 e COB-2**: nenhum leitor de página do eCAC foi escrito na extensão (malha, lote, CND,
  pré-preenchidas), porque não há o HTML real das páginas. Os textos foram corrigidos. O
  Integra Contador não informa malha nem lote e não emite CND de PF.
- **Credenciais eCAC do cliente**: mantidas. O COB-7 removeu só a senha do INSS. Guardar a
  senha gov.br do eCAC sem uso tem o mesmo problema de LGPD apontado no COB-1; fica para
  decisão de produto.
