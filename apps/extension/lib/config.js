/*
 * Configuração compartilhada da extensão Verifco (service worker, popup e content scripts).
 * Script clássico: define `globalThis.VerifcoConfig`. Só constantes; as funções ficam em
 * lib/format.js.
 */
(function () {
  /**
   * Serviços abertos pela aba "Ações eCAC" do Verifco.
   * Os endereços são os pontos de entrada públicos dos serviços; a Receita pode alterá-los.
   * Quando um endereço mudar, ajuste só esta tabela. Em caso de dúvida, use a página inicial
   * do eCAC: o aviso da extensão diz ao usuário qual serviço abrir.
   */
  const SERVICES = {
    carne_leao: { label: 'Carnê-Leão', url: 'https://www3.cav.receita.fazenda.gov.br/carneleao/' },
    meu_irpf: { label: 'Meu Imposto de Renda', url: 'https://www3.cav.receita.fazenda.gov.br/extratodirpf/' },
    cnd: { label: 'CND (certidão de débitos)', url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cpf' },
    fontes_pagadoras: { label: 'Rendimentos informados por fontes pagadoras', url: 'https://cav.receita.fazenda.gov.br/ecac/' },
  };

  /** Chaves do chrome.storage.local (ficam neste navegador). */
  const STORAGE = {
    settings: 'verifco.settings', // { webUrl, apiUrl, token }
    log: 'verifco.log', // últimos envios: [{ at, name, cpf (mascarado), what, ok, detail }]
  };

  /** Chaves do chrome.storage.session (memória do navegador, apagada ao fechá-lo). */
  const SESSION = {
    pending: 'verifco.pending', // último "Acessar" do Verifco: { service, serviceLabel, cpf, at }
    client: 'verifco.client', // cliente escolhido no popup: { cpf, name, at }
    draft: 'verifco.draft', // seleção vinda do menu de contexto sem cliente escolhido
  };

  /** Contexto de "abrir serviço" vale por 30 minutos (mostra o CPF do cliente no eCAC). */
  const CONTEXT_TTL_MS = 30 * 60 * 1000;

  const LIMITS = {
    fileBytes: 25 * 1024 * 1024, // limite de POST /api/sync/documents
    pageTextChars: 8000, // texto de "Registrar esta página"
    base64Chars: 14_000_000, // limite do anexo em POST /api/sync/ecac-records
    logEntries: 30,
    customers: 20,
    draftTtlMs: 10 * 60 * 1000,
  };

  globalThis.VerifcoConfig = { SERVICES, STORAGE, SESSION, CONTEXT_TTL_MS, LIMITS };
})();
