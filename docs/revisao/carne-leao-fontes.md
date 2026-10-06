# Conferência dos códigos do Carnê-Leão (COB-9)

Conferência em 06/10/2026, na retomada da onda 2. Foram baixadas diretamente do domínio
da Receita Federal as tabelas abaixo, extraídas as linhas de código/descrição e comparadas
com `packages/shared/src/cashbook.ts`. Todos os códigos locais têm correspondência oficial.
As descrições de ocupações coincidem, descontando pontuação e a validade que fica nos campos
`from`/`until`. O plano de contas contém as mesmas 32 contas do modelo oficial.

- [Rendimentos](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/rendimentos): cinco códigos.
- [Ocupações](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/ocupacoes): inclui os códigos militares e sem ocupação. A própria tabela limita 229 a 2023 e introduz 230, 231 e 232 em 2024; esses limites são respeitados no código.
- [Pagamentos gerais](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/pagamentos): P20.01.00001, 00002 e 00003 na tabela atual.
- [Plano de contas](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/pagamentos-plano): 14 contas P10 e 18 contas P11. O texto oficial permite contas personalizadas do plano do contribuinte, por isso a ausência de uma conta P10/P11 na tabela padrão não a invalida.
- [Modelos de escrituração de 2025](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/escrituracao-do-carne-leao/escrituracao-carne-leao.zip/view): o CSV `Modelos de Arquivo para Pagamentos.csv` confirma o código histórico P20.01.00004, para imposto pago.
- [Manual, seção Pagamentos](https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/manual): confirma que, a partir do ano-calendário 2026, o imposto pago passa a ser importado automaticamente e sua inclusão manual deixa de ser permitida. Por isso P20.01.00004 só é aceito até 2025.

Os testes de domínio cobrem código inexistente, ocupação inexistente, transição 2023/2024,
transição 2025/2026 e contas personalizadas. A tela filtra as tabelas pelo ano-calendário.
Isso valida os códigos publicados; não certifica um plano personalizado nem uma nova alteração
futura do manual da Receita.
