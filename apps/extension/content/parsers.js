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
   * Pré-preenchida (Meu Imposto de Renda › Declaração pré-preenchida) — SEM parser, de propósito.
   *
   * Não há fonte oficial automática: o SERPRO Integra Contador, usado pela sincronização do eCAC na
   * API, não tem serviço de pré-preenchida, e esta página não tem leitor porque o HTML não é público
   * (não inventamos seletores). Hoje o arquivo chega ao Verifco pelo sincronizador (pasta de
   * pré-preenchidas, `--pasta-pre`) ou pelo envio manual na tela Pré-preenchidas.
   *
   * Para implementar: na página real, localize o link de download do arquivo, baixe-o com `fetch` na
   * própria origem (vale a sessão do navegador) e envie pelo service worker, em multipart, para
   * POST /api/sync/prefilled (campos `file`, `cpf` = ctx.cpf e `ano` = ano-exercício), com o token
   * da extensão (a rota aceita os escopos Extensão do navegador e Sincronizador). Não é um registro de
   * /sync/ecac-records: não use `C.register` com `kind` para ele.
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
