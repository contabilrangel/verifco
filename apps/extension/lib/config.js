/*
 * Configuração compartilhada da extensão Verifco (service worker, popup e content scripts).
 * Script clássico: define `globalThis.VerifcoConfig`.
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

  /** Chaves do chrome.storage.local. */
  const STORAGE = {
    settings: 'verifco.settings', // { webUrl, apiUrl, token, captureEnabled, enabledParsers: string[] }
  };

  /** Contexto de "abrir serviço" vale por 30 minutos (mostra o CPF do cliente no eCAC). */
  const CONTEXT_TTL_MS = 30 * 60 * 1000;

  const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');
  const formatCpf = (v) => {
    const d = onlyDigits(v);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return String(v ?? '');
  };
  /** Origem (protocolo + host + porta) de uma URL, ou null. */
  const originOf = (url) => {
    try {
      const u = new URL(String(url).trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
      return null;
    }
  };

  globalThis.VerifcoConfig = { SERVICES, STORAGE, CONTEXT_TTL_MS, onlyDigits, formatCpf, originOf };
})();
