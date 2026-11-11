/*
 * Estado da extensão no chrome.storage, usado pelo service worker e pelo popup.
 * Script clássico: define `globalThis.VerifcoStore`. Depende de lib/config.js e lib/format.js.
 *
 * - local (fica neste navegador): configuração (endereços e token) e os últimos envios;
 * - session (some ao fechar o navegador): CPF do último "Acessar", cliente escolhido no popup e
 *   a seleção à espera de um cliente.
 */
(function () {
  const { STORAGE, SESSION, CONTEXT_TTL_MS, LIMITS } = globalThis.VerifcoConfig;
  const F = globalThis.VerifcoFormat;

  const sessionGet = async (key) => (await chrome.storage.session.get(key))[key] ?? null;
  const sessionSet = (key, value) => (value ? chrome.storage.session.set({ [key]: value }) : chrome.storage.session.remove(key));

  async function getSettings() {
    const data = await chrome.storage.local.get(STORAGE.settings);
    const s = data[STORAGE.settings] ?? {};
    return { webUrl: s.webUrl ?? '', apiUrl: s.apiUrl ?? '', token: s.token ?? '' };
  }
  const saveSettings = ({ webUrl, apiUrl, token }) => chrome.storage.local.set({ [STORAGE.settings]: { webUrl, apiUrl, token } });

  /** Último "Acessar" do Verifco (serviço + CPF), mesmo vencido. */
  const getPending = () => sessionGet(SESSION.pending);
  const setPending = (value) => sessionSet(SESSION.pending, value);
  /** O mesmo, só enquanto vale (30 minutos). */
  async function activePending() {
    const p = await getPending();
    return p && Date.now() - Number(p.at ?? 0) < CONTEXT_TTL_MS ? p : null;
  }

  const getSelectedClient = () => sessionGet(SESSION.client);
  const setSelectedClient = (client) => sessionSet(SESSION.client, client ? { cpf: F.onlyDigits(client.cpf), name: client.name ?? '', at: Date.now() } : null);

  /** Cliente em uso agora: o escolhido no popup ou o do último "Acessar" (o mais recente). */
  async function currentClient() {
    const [selected, pending] = await Promise.all([getSelectedClient(), getPending()]);
    return F.resolveClient(selected, pending, Date.now(), CONTEXT_TTL_MS);
  }

  /** Seleção vinda do menu de contexto quando não havia cliente: o popup termina o envio. */
  async function getDraft() {
    const d = await sessionGet(SESSION.draft);
    return d && Date.now() - Number(d.at ?? 0) < LIMITS.draftTtlMs ? d : null;
  }
  const setDraft = (draft) => sessionSet(SESSION.draft, draft ? { ...draft, at: Date.now() } : null);

  async function getLog() {
    const data = await chrome.storage.local.get(STORAGE.log);
    return Array.isArray(data[STORAGE.log]) ? data[STORAGE.log] : [];
  }
  const clearLog = () => chrome.storage.local.remove(STORAGE.log);

  /** Selo no ícone com o último resultado: ✓ (deu certo) ou ! (erro). Some ao abrir o popup. */
  async function setBadge(ok) {
    try {
      await chrome.action.setBadgeBackgroundColor({ color: ok ? '#25702e' : '#be3450' });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      await chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
    } catch {
      /* o selo é só um aviso */
    }
  }
  const clearBadge = () => chrome.action.setBadgeText({ text: '' }).catch(() => {});

  /** Anota um envio no histórico (CPF mascarado) e atualiza o selo do ícone. */
  async function logResult({ cpf, name, what, ok, detail }) {
    const list = F.appendLog(await getLog(), { at: Date.now(), cpf, name, what, ok, detail }, LIMITS.logEntries);
    await chrome.storage.local.set({ [STORAGE.log]: list });
    await setBadge(ok);
    return list;
  }

  globalThis.VerifcoStore = {
    getSettings,
    saveSettings,
    getPending,
    setPending,
    activePending,
    getSelectedClient,
    setSelectedClient,
    currentClient,
    getDraft,
    setDraft,
    getLog,
    clearLog,
    logResult,
    clearBadge,
  };
})();
