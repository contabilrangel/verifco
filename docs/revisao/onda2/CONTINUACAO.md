# Onda 2: integração concluída em 06/10/2026

Os sete lotes foram reconstruídos sobre `b20175e`, verificados isoladamente e integrados no
branch `llypedev/fervent-franklin-qcc0y1`, a partir do ponto de interrupção `95a7066`.
O código da onda 2 agora faz parte do branch. Os patches de rascunho foram retirados desta
pasta depois da integração; o histórico em `95a7066` conserva os patches e o roteiro original.

Leia primeiro [onda2-verificacao.json](../onda2-verificacao.json), que registra por lote o
escopo, as verificações, as divergências e os reparos feitos na integração. As convenções
continuam em [REGRAS-DOS-LOTES.md](REGRAS-DOS-LOTES.md). As fontes do Carnê-Leão estão em
[carne-leao-fontes.md](../carne-leao-fontes.md).

## Commits dos lotes no branch

| Lote | Commit integrado | Resultado |
| --- | --- | --- |
| A — fila de tarefas | `0e88a55` | Recuperação, concorrência, prioridade, cobrança e reenvio |
| B — arquivos | `cc746fe` | Backup e downloads em streaming/ZIP64; uploads limitados |
| C — declarações | `866e5df` | Estados, permissões, saldo e transações |
| D — comunicação | `e809ee1` | Mala direta/importação na fila, links e PDF único |
| F1 — consistência | `1990ff9` | Brasília, auditoria, permissões e contratos |
| E — integrações | `a8235b0` | Robô SERPRO, WhatsApp e retirada do INSS |
| F2 — desempenho e resíduos | `cd70281` | Contadores, índices, códigos oficiais, importações e CSS |

Os commits seguintes consolidam as migrações e corrigem interações entre os lotes. Em especial:
limite de declarações no bulk sob trava, prioridade das mensagens geradas em lote, variáveis
protegidas dos modelos Meta, conclusão do eCAC pelos filhos duráveis, visualização de tarefas
abandonadas, consultas financeiras sem busca quadrática e exceções restritas no contrato vencido.
Os textos das telas do robô e dos downloads também esclarecem o limite da extensão.

## Verificações confirmadas

Cada lote passou em instalação com lockfile congelado, typecheck, suítes completas da API,
shared e web, CSS, build da web e db:check, com worktree limpa. As verificações da integração
passaram depois dos reparos:

- API: 32 arquivos, 337 testes.
- Shared: 15 arquivos, 140 testes.
- Web: 21 arquivos, 68 testes.
- Sincronizador: 5 testes.
- Total das quatro suítes: 550 testes; CSS: 9 testes (incluídos na suíte web).
- Typecheck, build web e db:check: verdes. O build mantém o aviso de bundle grande.

As suítes que compõem `pnpm test` foram executadas por pacote, sequencialmente, com dois
workers do Vitest para limitar memória. Houve falhas iniciais de integração; foram corrigidas
sem desativar testes. O relatório conserva esses resultados e descreve os reparos.
Testes de provedores usam respostas simuladas; a web foi verificada por testes de componentes,
CSS e build, sem inspeção visual em navegador real. Não houve deploy.

## Banco e dados existentes

- `0004_onda2`: única migração estrutural para tamanho bigint, fila com token/prioridade/pai,
  ID externo de mensagem, contadores de elaboração e índices.
- `0005_remove_senha_inss`: migração de dados que apaga as senhas INSS antigas, retira a
  permissão correspondente e registra aviso/auditoria por escritório afetado.
- Snapshots e journal foram gerados pelo Drizzle. A migração de dados foi criada com `--custom`.
- Migrações sobre dados antigos e reaplicação foram testadas com PGlite. A senha eCAC é
  preservada. Nenhuma migração foi executada em banco de produção nesta retomada.
- Os contadores antigos da elaboração são preenchidos em lotes na primeira consulta do
  exercício; os caminhos de alteração de documentos mantêm os contadores atualizados.

## Limites e decisões preservados

- **COB-3:** leitura de .DEC/XML não implementada: formato não público e ausência de arquivos
  reais para validar. O .REC é guardado e marca transmissão sem ler conteúdo ou número.
- **COB-4:** exportação .DBK não implementada pelo mesmo motivo. O pacote de elaboração
  continua identificado como diferente de uma cópia .DBK do programa IRPF.
- **COB-1/COB-2:** leitura de páginas eCAC pela extensão não implementada: falta o HTML real.
  SERPRO não fornece situação/malha/lote da declaração nem CND de pessoa física. Essas
  informações continuam com lançamento manual; as telas explicam a limitação.
- **Credenciais eCAC:** continuam guardadas sem uso, pendentes de decisão de produto,
  conforme a orientação recebida. A retirada do INSS não remove esses dados.
- **DAD-10:** uploads continuam em Buffer, limitados a 25 MiB por arquivo e 100 MiB por
  requisição, com validação antecipada da assinatura e consumo das partes rejeitadas. A
  recomendação de todo multipart passar por arquivo temporário em disco não foi implantada;
  leitores de planilha/PDF/IA ainda exigem Buffer. Backups e downloads usam streaming.
- **Carnê-Leão:** todos os códigos locais foram comparados com a Receita. A tabela respeita
  os limites oficiais por ano; contas P10/P11 personalizadas dependem do plano do contribuinte.
  Isso não certifica alterações futuras do manual nem valida um plano personalizado.

A onda 2 está integrada e o branch pode seguir a partir desse estado. Para adoção em produção,
use o processo de implantação do projeto, que inclui aplicar as migrações e configurar/testar
as integrações com as credenciais do escritório. Esse trabalho não foi executado nesta retomada.
