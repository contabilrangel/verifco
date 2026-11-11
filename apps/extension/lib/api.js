/*
 * Cliente da API de máquina do Verifco (`/api/sync/*`, `Authorization: Bearer vfk_...`).
 * Script clássico: define `globalThis.VerifcoApi`. Depende de lib/format.js.
 *
 * `createApi` recebe o `fetch`, a leitura da configuração e a versão da extensão, para ser usado
 * no service worker, no popup e nos testes (test/api.test.mjs, com um `fetch` de mentira).
 */
(function () {
  const F = globalThis.VerifcoFormat;

  /** Erro com a mensagem pronta para mostrar ao usuário. `status` 0 = não chegou a ter resposta. */
  class ApiError extends Error {
    constructor(message, status = 0, code = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }

  /** Identificação enviada em toda chamada: o servidor usa para avisar de versão antiga. */
  const clientHeader = (version) => `extension/${version} (chrome)`;

  /** Endereço da API: o campo próprio, senão o endereço do Verifco. */
  const apiBase = (settings) => F.originOf(settings?.apiUrl) ?? F.originOf(settings?.webUrl);

  const isConfigured = (settings) => Boolean(apiBase(settings) && settings?.token);

  /** Monta URL e cabeçalhos de uma chamada (sem fazer a chamada). */
  function buildRequest(settings, version, path, init = {}) {
    const base = apiBase(settings);
    if (!base || !settings?.token) throw new ApiError('Configure o endereço do Verifco e o token na extensão.', 0, 'not_configured');
    return {
      url: `${base}/api${path}`,
      init: {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${settings.token}`, 'X-Verifco-Client': clientHeader(version) },
      },
    };
  }

  /** Mensagem de um erro HTTP: a do servidor (`{ error }`, em português) ou uma padrão. */
  function errorMessage(status, body) {
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (status === 401) return 'Token recusado pelo Verifco. Confira o token em Configuração.';
    if (status === 403) return 'Este token não tem permissão para este envio (use um token do escopo Extensão).';
    if (status === 404) return 'Este servidor do Verifco ainda não aceita este tipo de envio.';
    if (status === 413) return 'Arquivo grande demais para o Verifco.';
    if (status === 426) return 'Esta versão da extensão não é mais aceita. Atualize a extensão.';
    if (status === 429) return 'Muitos envios em pouco tempo. Aguarde um instante e tente de novo.';
    return `Erro ${status} na API do Verifco.`;
  }

  /** Campos de texto primeiro, arquivo por último (o servidor lê o formulário em ordem). */
  function buildForm(fields, file, filename) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      form.append(key, String(value));
    }
    form.append('file', file, filename);
    return form;
  }

  /**
   * @param {{ fetch: typeof fetch, getSettings: () => Promise<object>|object, version: string }} deps
   */
  function createApi({ fetch, getSettings, version }) {
    async function call(path, init) {
      const req = buildRequest(await getSettings(), version, path, init);
      let res;
      try {
        res = await fetch(req.url, req.init);
      } catch {
        throw new ApiError('Não foi possível falar com o Verifco. Confira o endereço em Configuração e a sua conexão.', 0, 'network');
      }
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) throw new ApiError(errorMessage(res.status, body), res.status);
      return body;
    }

    return {
      /** Confere o token; `client` (versões) pode não vir em servidores antigos. */
      async whoami() {
        const who = await call('/sync/whoami');
        const c = who?.client && typeof who.client === 'object' ? who.client : null;
        return {
          office: { id: who?.office?.id ?? null, name: String(who?.office?.name ?? '') },
          token: { name: String(who?.token?.name ?? ''), scope: String(who?.token?.scope ?? '') },
          client: c ? { latest: String(c.latest ?? ''), minSupported: String(c.minSupported ?? ''), updateAvailable: Boolean(c.updateAvailable), unsupported: Boolean(c.unsupported) } : null,
        };
      },

      /** Busca clientes por nome ou CPF (até `limit`). */
      async customers(q = '', limit = 20) {
        const out = await call(`/sync/customers?q=${encodeURIComponent(String(q).trim())}&limit=${limit}`);
        const rows = Array.isArray(out) ? out : [];
        const list = rows.map(F.normalizeCustomer).filter(Boolean);
        // servidor antigo (sem `hasProcurator`): devolve todos os clientes com procurador, sem filtrar
        const legacy = rows.some((r) => r && typeof r.hasProcurator !== 'boolean');
        return legacy || list.length > limit ? F.filterCustomers(list, q, limit) : list;
      },

      /** Arquivo para os documentos do cliente. */
      sendDocument({ file, filename, cpf, year, category, origin, title }) {
        const fields = {
          cpf: F.onlyDigits(cpf),
          ano: year ?? '',
          categoria: category || 'other',
          origem: String(origin ?? '').slice(0, 500),
          titulo: String(title ?? '').slice(0, 200),
        };
        return call('/sync/documents', { method: 'POST', body: buildForm(fields, file, F.sanitizeFileName(filename ?? file?.name) || 'arquivo') });
      },

      /** Arquivo da declaração pré-preenchida (o ano-exercício é obrigatório). */
      sendPrefilled({ file, filename, cpf, year }) {
        return call('/sync/prefilled', { method: 'POST', body: buildForm({ cpf: F.onlyDigits(cpf), ano: year }, file, F.sanitizeFileName(filename ?? file?.name) || 'arquivo') });
      },

      /** Um registro do eCAC; lança ApiError quando o servidor recusa o item. */
      async sendRecord(record) {
        const out = await call('/sync/ecac-records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [record] }),
        });
        const item = Array.isArray(out?.results) ? out.results[0] : null;
        if (!item) throw new ApiError('Resposta inesperada do Verifco.', 0, 'bad_response');
        if (!item.ok) throw new ApiError(String(item.error || 'O Verifco recusou o registro.'), Number(item.status) || 0);
        return item;
      },
    };
  }

  globalThis.VerifcoApi = { ApiError, clientHeader, apiBase, isConfigured, buildRequest, errorMessage, buildForm, createApi };
})();
