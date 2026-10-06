/*
 * Service worker da extensão Verifco (Manifest V3).
 *
 * Mensagens aceitas (chrome.runtime.sendMessage):
 *   { kind: 'open-ecac', service, cpf }      ← content/bridge.js (página do Verifco)
 *   { kind: 'get-context' }                  ← content/ecac.js (páginas do eCAC)
 *   { kind: 'send-records', records }        ← content/ecac.js (registros já interpretados)
 *   { kind: 'test-connection' }              ← popup
 *   { kind: 'settings-changed' }             ← popup (registra a ponte no endereço do Verifco)
 *
 * O token (vfk_...) fica no chrome.storage.local e só é usado aqui, nas chamadas à API.
 */
importScripts('lib/config.js');

const { SERVICES, STORAGE, CONTEXT_TTL_MS, onlyDigits, originOf } = globalThis.VerifcoConfig;
const BRIDGE_ID = 'verifco-bridge-dynamic';

/**
 * Contexto do último "Acessar" (serviço + CPF). Fica no chrome.storage.session (memória do
 * navegador, apagado ao fechá-lo), porque o service worker pode ser suspenso a qualquer momento.
 */
const PENDING_KEY = 'verifco.pending';
const getPending = async () => (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY] ?? null;
const setPending = (value) => (value ? chrome.storage.session.set({ [PENDING_KEY]: value }) : chrome.storage.session.remove(PENDING_KEY));

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE.settings);
  return { webUrl: '', apiUrl: '', token: '', captureEnabled: false, enabledParsers: [], ...(data[STORAGE.settings] ?? {}) };
}

function apiBase(settings) {
  return originOf(settings.apiUrl) ?? originOf(settings.webUrl);
}

async function callApi(path, init = {}) {
  const settings = await getSettings();
  const base = apiBase(settings);
  if (!base || !settings.token) throw new Error('Configure o endereço do Verifco e o token na extensão.');
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${settings.token}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(body?.error ?? `Erro ${res.status} na API do Verifco.`);
  return body;
}

/**
 * Registra a ponte (content/bridge.js) no endereço do Verifco configurado, além dos endereços
 * fixos do manifest (localhost e *.verifco.com.br). Exige a permissão do site, pedida no popup.
 */
async function syncBridgeRegistration() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] });
    const settings = await getSettings();
    const origin = originOf(settings.webUrl);
    if (!origin) return;
    const pattern = `${origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [pattern] }))) return;
    await chrome.scripting.registerContentScripts([
      { id: BRIDGE_ID, matches: [pattern], js: ['lib/config.js', 'content/bridge.js'], runAt: 'document_start', persistAcrossSessions: true },
    ]);
  } catch (err) {
    console.warn('[Verifco] Não foi possível registrar a ponte no endereço configurado:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => void syncBridgeRegistration());
chrome.runtime.onStartup.addListener(() => void syncBridgeRegistration());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.kind) {
      case 'open-ecac': {
        const service = SERVICES[msg.service];
        if (!service) return { ok: false, error: 'Serviço do eCAC desconhecido.' };
        const cpf = onlyDigits(msg.cpf);
        if (cpf && cpf.length !== 11 && cpf.length !== 14) return { ok: false, error: 'CPF/CNPJ inválido.' };
        await setPending({ service: msg.service, serviceLabel: service.label, cpf, at: Date.now(), fromTab: sender.tab?.id ?? null });
        await chrome.tabs.create({ url: service.url, active: true });
        return { ok: true };
      }
      case 'get-context': {
        const settings = await getSettings();
        const pending = await getPending();
        const ctx = pending && Date.now() - pending.at < CONTEXT_TTL_MS ? pending : null;
        return { ok: true, context: ctx, captureEnabled: Boolean(settings.captureEnabled), enabledParsers: settings.enabledParsers ?? [], configured: Boolean(apiBase(settings) && settings.token) };
      }
      case 'clear-context':
        await setPending(null);
        return { ok: true };
      case 'send-records': {
        const records = Array.isArray(msg.records) ? msg.records : [];
        if (!records.length) return { ok: true, sent: 0 };
        const result = await callApi('/sync/ecac-records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records }),
        });
        return { ok: true, result };
      }
      case 'test-connection': {
        const who = await callApi('/sync/whoami');
        return { ok: true, who };
      }
      case 'settings-changed':
        await syncBridgeRegistration();
        return { ok: true };
      default:
        return { ok: false, error: 'Mensagem desconhecida.' };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // resposta assíncrona
});
