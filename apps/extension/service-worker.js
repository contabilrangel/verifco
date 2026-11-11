/*
 * Service worker da extensão Verifco (Manifest V3).
 *
 * Mensagens aceitas (chrome.runtime.sendMessage):
 *   { kind: 'open-ecac', service, cpf }   ← content/bridge.js (página do Verifco)
 *   { kind: 'get-context' }               ← content/ecac.js (aviso nas páginas da Receita)
 *   { kind: 'clear-context' }             ← content/ecac.js (aviso fechado)
 *   { kind: 'register-page' }             ← content/ecac.js (botão "Registrar página" do aviso)
 *   { kind: 'test-connection' }           ← popup
 *   { kind: 'settings-changed' }          ← popup (registra a ponte no endereço do Verifco)
 *
 * Menu de contexto: "Enviar seleção ao Verifco" e "Enviar este link/arquivo ao Verifco".
 *
 * Nada é enviado sozinho: toda chamada à API nasce de um clique do usuário (popup, aviso ou menu).
 * O token (vfk_...) fica no chrome.storage.local e só é usado nas chamadas à API do Verifco.
 */
importScripts('lib/config.js', 'lib/format.js', 'lib/statuses.js', 'lib/api.js', 'lib/capture.js', 'lib/store.js', 'lib/actions.js');

const { SERVICES, LIMITS } = globalThis.VerifcoConfig;
const F = globalThis.VerifcoFormat;
const Store = globalThis.VerifcoStore;
const Capture = globalThis.VerifcoCapture;
const { createApi, isConfigured } = globalThis.VerifcoApi;

const BRIDGE_ID = 'verifco-bridge-dynamic';
const MENU = { selection: 'verifco-selection', link: 'verifco-link', pdf: 'verifco-pdf' };

const api = createApi({ fetch: (url, init) => fetch(url, init), getSettings: Store.getSettings, version: chrome.runtime.getManifest().version });
const actions = globalThis.VerifcoActions.createActions({ api, log: Store.logResult });

const errorText = (err) => (err instanceof Error ? err.message : String(err));
const clientLabel = (client) => client.name || F.formatCpf(client.cpf);

/**
 * Registra a ponte (content/bridge.js) no endereço do Verifco configurado, além dos endereços
 * fixos do manifest (localhost e *.verifco.com.br). Exige a permissão do site, pedida no popup.
 */
async function syncBridgeRegistration() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [BRIDGE_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] });
    const settings = await Store.getSettings();
    const origin = F.originOf(settings.webUrl);
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

/** Itens do menu de contexto (recriados na instalação e ao abrir o navegador). */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    const add = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
    add({ id: MENU.selection, title: 'Enviar seleção ao Verifco', contexts: ['selection'] });
    add({ id: MENU.link, title: 'Enviar este link/arquivo ao Verifco', contexts: ['link', 'image'] });
    // PDF aberto na aba: só aparece quando o endereço termina em .pdf
    add({ id: MENU.pdf, title: 'Enviar este PDF ao Verifco', contexts: ['page'], documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://*/*.PDF?*'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void syncBridgeRegistration();
  setupMenus();
});
chrome.runtime.onStartup.addListener(() => {
  void syncBridgeRegistration();
  setupMenus();
});

function notify(title, message) {
  try {
    const done = chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message });
    if (done && typeof done.catch === 'function') done.catch(() => {});
  } catch {
    /* sem aviso do sistema: o resultado fica em "Últimos envios" e no selo do ícone */
  }
}

/** Abre o popup para o usuário escolher o cliente; devolve false se o navegador não deixar. */
async function openPopup() {
  try {
    if (typeof chrome.action.openPopup !== 'function') return false;
    await chrome.action.openPopup();
    return true;
  } catch {
    return false;
  }
}

/** Seleção de texto → registro `other` do cliente em uso. */
async function sendSelection(info, tab) {
  let page = null;
  // com o clique no menu o navegador libera a aba (activeTab): lê a seleção com as quebras de linha
  if (tab?.id !== undefined) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId ?? 0] }, func: Capture.collectPage, args: [LIMITS.pageTextChars] });
      if (res?.result?.selection) page = Capture.mergeFrames([{ ...res.result, top: true }], LIMITS.pageTextChars);
    } catch {
      page = null;
    }
  }
  if (!page) {
    const { text, truncated } = F.truncateText(F.cleanText(info.selectionText), LIMITS.pageTextChars);
    page = { title: '', url: '', text, fromSelection: true, truncated };
  }
  // título e endereço são os da aba (a seleção pode estar num quadro interno)
  page.title = String(tab?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || page.title;
  page.url = info.pageUrl || tab?.url || page.url;
  if (!page.text) return notify('Verifco', 'Não há texto selecionado para enviar.');

  const client = await Store.currentClient();
  if (!client) {
    // guarda a seleção: o popup mostra o texto e termina o envio depois de escolhido o cliente
    await Store.setDraft(page);
    if (!(await openPopup())) notify('Escolha o cliente', 'Clique no ícone do Verifco, escolha o cliente e confirme o envio da seleção.');
    return;
  }
  const res = await actions.registerPage({ client, page });
  notify(res.ok ? 'Seleção enviada ao Verifco' : 'A seleção não foi enviada', res.ok ? `Registrada para ${clientLabel(client)}.` : res.error);
}

/** Baixa o endereço com a sessão do navegador. Lança com o motivo quando não vem um arquivo. */
async function fetchAsFile(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  } catch {
    throw new Error('o navegador não deixou a extensão baixar deste site');
  }
  if (!res.ok) throw new Error(`o site respondeu com erro ${res.status}`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') throw new Error('o link abre uma página, não um arquivo');
  if (Number(res.headers.get('content-length') ?? 0) > LIMITS.fileBytes) throw new Error(`o arquivo passa de ${F.formatBytes(LIMITS.fileBytes)}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('o arquivo veio vazio');
  if (blob.size > LIMITS.fileBytes) throw new Error(`o arquivo passa de ${F.formatBytes(LIMITS.fileBytes)}`);
  return { blob, filename: F.pickFileName({ disposition: res.headers.get('content-disposition'), url: res.url || url, mime }) };
}

/** Link, imagem ou PDF aberto → arquivo nos documentos do cliente em uso. */
async function sendLink(info, allowPage) {
  const manual = 'Baixe o arquivo e use “Enviar arquivo” na extensão.';
  const url = F.pickMenuUrl(info, allowPage);
  if (!url) return notify('O arquivo não foi enviado', `Este link não aponta para um arquivo que a extensão consiga baixar. ${manual}`);
  const client = await Store.currentClient();
  if (!client) {
    notify('Escolha o cliente', 'Clique no ícone do Verifco, escolha o cliente e repita “Enviar este link/arquivo ao Verifco”.');
    await openPopup();
    return;
  }
  let fetched;
  try {
    fetched = await fetchAsFile(url);
  } catch (err) {
    const reason = errorText(err);
    await Store.logResult({ cpf: client.cpf, name: client.name, what: `Link: ${F.fileNameFromUrl(url) ?? url.slice(0, 80)}`, ok: false, detail: `Não foi possível baixar: ${reason}.` });
    return notify('O arquivo não foi enviado', `Não foi possível baixar (${reason}). ${manual}`);
  }
  const res = await actions.sendFile({ client, file: fetched.blob, filename: fetched.filename, origin: info.pageUrl || url, maxBytes: LIMITS.fileBytes });
  notify(res.ok ? 'Arquivo enviado ao Verifco' : 'O arquivo não foi enviado', res.ok ? `${fetched.filename}: ${res.message}` : res.error);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const work = info.menuItemId === MENU.selection ? sendSelection(info, tab) : info.menuItemId === MENU.link ? sendLink(info, false) : info.menuItemId === MENU.pdf ? sendLink(info, true) : null;
  if (work) work.catch((err) => notify('Verifco', errorText(err)));
});

/** Botão "Registrar página" do aviso: lê a aba de quem pediu e registra para o CPF do "Acessar". */
async function registerFromBanner(sender) {
  const tab = sender.tab;
  if (!tab || tab.id === undefined) return { ok: false, error: 'Aba não identificada.' };
  const pending = await Store.activePending();
  if (!pending?.cpf) return { ok: false, error: 'O CPF do cliente expirou. Clique em “Acessar” no Verifco de novo.' };
  const selected = await Store.getSelectedClient();
  const client = { cpf: pending.cpf, name: selected && selected.cpf === pending.cpf ? selected.name : null };
  const page = await Capture.captureTab(tab.id, LIMITS.pageTextChars);
  // a imagem depende do activeTab (o usuário ter clicado no ícone da extensão nesta aba); sem ela, vai só o texto
  let screenshot = null;
  try {
    if (tab.active) screenshot = await Capture.captureScreenshot(tab.windowId, LIMITS.base64Chars);
  } catch {
    screenshot = null;
  }
  return actions.registerPage({ client, page, screenshot });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.kind) {
      case 'open-ecac': {
        const service = SERVICES[msg.service];
        if (!service) return { ok: false, error: 'Serviço do eCAC desconhecido.' };
        const cpf = F.onlyDigits(msg.cpf);
        if (cpf && cpf.length !== 11 && cpf.length !== 14) return { ok: false, error: 'CPF/CNPJ inválido.' };
        await Store.setPending({ service: msg.service, serviceLabel: service.label, cpf, at: Date.now(), fromTab: sender.tab?.id ?? null });
        await chrome.tabs.create({ url: service.url, active: true });
        return { ok: true };
      }
      case 'get-context':
        return { ok: true, context: await Store.activePending(), configured: isConfigured(await Store.getSettings()) };
      case 'clear-context':
        await Store.setPending(null);
        return { ok: true };
      case 'register-page':
        return registerFromBanner(sender);
      case 'test-connection':
        return { ok: true, who: await api.whoami() };
      case 'settings-changed':
        await syncBridgeRegistration();
        return { ok: true };
      default:
        return { ok: false, error: 'Mensagem desconhecida.' };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
  return true; // resposta assíncrona
});
