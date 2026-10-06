/*
 * Parsers de páginas do eCAC — PONTOS DE EXTENSÃO.
 *
 * Todos começam desligados e devolvem lista vazia: a estrutura HTML das páginas da Receita não
 * é pública e muda sem aviso, então não inventamos seletores. Para implementar um parser:
 *
 *   1. Abra a página no eCAC (com o cliente selecionado) e inspecione o HTML real.
 *   2. Leia os dados com `doc.querySelector(...)` ou com os utilitários em `ctx.helpers`
 *      (`valueByLabel`, `moneyToCents`, `dateToIso`).
 *   3. Devolva registros no formato da API (veja capture-core.js e o README).
 *      Use `externalId` estável (nº do recibo, id da mensagem) para não duplicar.
 *   4. Teste com a captura habilitada no popup e o parser marcado.
 *
 * O CPF do cliente vem em `ctx.cpf` quando a aba foi aberta pelo botão "Acessar" do Verifco.
 */
(function () {
  const C = globalThis.VerifcoCapture;

  C.register({
    id: 'meu-irpf-situacao',
    description: 'Meu Imposto de Renda — situação da declaração (a implementar)',
    matches: [/^https:\/\/www3\.cav\.receita\.fazenda\.gov\.br\/extratodirpf\//],
    parse(doc, ctx) {
      // Exemplo do que devolver depois de ler a página:
      // return [{ kind: 'declaration', cpf: ctx.cpf, year: 2026, externalId: '<nº do recibo>',
      //           data: { status: 'processing', type: 'Ajuste anual', isRectification: false, taxation: 'simplified' } }];
      return [];
    },
  });

  C.register({
    id: 'caixa-postal',
    description: 'Caixa postal do eCAC — mensagens (a implementar)',
    matches: [/^https:\/\/cav\.receita\.fazenda\.gov\.br\/ecac\//],
    parse(doc, ctx) {
      // Exemplo: [{ kind: 'mailbox_message', cpf: ctx.cpf, externalId: '<id da mensagem>',
      //             data: { subject: '...', receivedAt: '2026-04-01', read: false } }]
      return [];
    },
  });

  /*
   * Pré-preenchida (Meu Imposto de Renda › Declaração pré-preenchida) — DESLIGADA, sem parser.
   *
   * Não existe fonte oficial automática: o SERPRO Integra Contador não tem serviço de pré-preenchida
   * (catálogo conferido em 06/10/2026). A busca automática depende de um leitor desta página, que
   * não foi escrito porque o HTML não é público. Hoje o arquivo chega pelo sincronizador (pasta de
   * pré-preenchidas) ou pelo envio manual na tela Pré-preenchidas do Verifco.
   *
   * Para implementar: na página real, localize o link/botão de download do arquivo, baixe-o com
   * `fetch` na própria origem (a sessão do navegador vale) e envie em multipart para
   * POST /api/sync/prefilled (campos `file`, `cpf` = ctx.cpf e `ano`), pelo service worker, com o
   * token da extensão. Não é um registro de `/sync/ecac-records`, então não use `C.register` com
   * `kind`.
   */

  C.register({
    id: 'certidao-cnd',
    description: 'Emissão de certidão (CND) — situação e PDF (a implementar)',
    matches: [/^https:\/\/servicos\.receitafederal\.gov\.br\/servico\/certidoes/],
    parse(doc, ctx) {
      // Exemplo: [{ kind: 'cnd', cpf: ctx.cpf, data: { status: 'success', issuedAt: '2026-04-02', validUntil: '2026-10-01' },
      //             file: { filename: 'cnd.pdf', mimeType: 'application/pdf', base64: '<conteúdo>' } }]
      return [];
    },
  });
})();
