/*
 * Popup da extensão: escolhe o cliente e faz os envios ao Verifco (arquivo, página, situação da
 * declaração e CND), mostra os últimos envios e guarda a configuração (endereços e token).
 * Nada é enviado sem um clique em um dos botões de envio.
 */
(function () {
  const { LIMITS } = globalThis.VerifcoConfig;
  const F = globalThis.VerifcoFormat;
  const S = globalThis.VerifcoStatuses;
  const Api = globalThis.VerifcoApi;
  const Capture = globalThis.VerifcoCapture;
  const Store = globalThis.VerifcoStore;

  const $ = (id) => document.getElementById(id);
  const version = chrome.runtime.getManifest().version;
  /** Aberto em janela própria ("Abrir em janela"): não há aba ativa para ler. */
  const inWindow = new URLSearchParams(location.search).has('janela');
  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  const api = Api.createApi({ fetch: (url, init) => fetch(url, init), getSettings: Store.getSettings, version });
  const actions = globalThis.VerifcoActions.createActions({
    api,
    log: async (entry) => {
      await Store.logResult(entry);
      await renderLog();
    },
  });

  let settings = { webUrl: '', apiUrl: '', token: '' };
  let client = null; // { cpf, name, fromContext }
  let files = []; // arquivos escolhidos
  let page = null; // página lida: { title, url, text, fromSelection, truncated }
  let pageTab = null; // aba de onde veio
  let pageIsDraft = false; // seleção vinda do menu de contexto

  const setStatus = (id, text, kind = '') => {
    const el = $(id);
    el.textContent = text;
    el.className = `status ${kind}`.trim();
  };
  const busy = (form, on) => {
    for (const b of form.querySelectorAll('button')) b.disabled = on;
  };
  const fillSelect = (select, map, { placeholder = null, value = '' } = {}) => {
    select.textContent = '';
    if (placeholder) select.append(new Option(placeholder, ''));
    for (const [key, label] of Object.entries(map)) select.append(new Option(label, key));
    select.value = value;
  };
  const docLabel = (cpf) => `${F.onlyDigits(cpf).length === 14 ? 'CNPJ' : 'CPF'} ${F.formatCpf(cpf)}`;

  // ------------------------------------------------------------------ conexão e avisos
  function showNotice(parts, kind = '') {
    const el = $('notice');
    el.textContent = '';
    el.className = `notice ${kind}`.trim();
    el.hidden = !parts.length;
    for (const p of parts) el.append(p);
  }

  /** Link para a Central de downloads do Verifco configurado (ou só o texto, sem endereço). */
  function downloadsLink() {
    const origin = F.originOf(settings.webUrl);
    if (!origin) return document.createTextNode('Central de downloads do Verifco');
    const a = document.createElement('a');
    a.href = `${origin}/downloads`;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Central de downloads do Verifco';
    return a;
  }

  async function checkConnection() {
    const conn = $('conn');
    if (!Api.isConfigured(settings)) {
      conn.textContent = 'Não conectada';
      conn.className = 'conn error';
      conn.title = '';
      $('config').open = true;
      showNotice([]);
      return;
    }
    conn.textContent = 'Conferindo a conexão…';
    conn.className = 'conn';
    try {
      const who = await api.whoami();
      conn.textContent = who.office.name || 'Conectada';
      conn.className = 'conn ok';
      conn.title = `Conectada a ${who.office.name} (token “${who.token.name}”)`;
      const c = who.client; // servidores antigos não mandam
      if (c?.unsupported) {
        showNotice([`Esta versão da extensão (${version}) não é mais aceita pelo Verifco. Baixe a versão ${c.latest || 'nova'} na `, downloadsLink(), '.'], 'error');
      } else if (c?.updateAvailable) {
        showNotice([`Há uma versão nova da extensão${c.latest ? ` (${c.latest})` : ''}. Baixe na `, downloadsLink(), '.']);
      } else {
        showNotice([]);
      }
    } catch (err) {
      conn.textContent = 'Sem conexão';
      conn.className = 'conn error';
      conn.title = errorText(err);
      showNotice([errorText(err)], 'error');
    }
  }

  // ------------------------------------------------------------------ cliente
  let results = [];
  let activeIndex = -1;
  let searchSeq = 0;
  let searchTimer = null;

  function renderClient() {
    $('clientChosen').hidden = !client;
    $('clientPicker').hidden = Boolean(client);
    if (!client) return;
    $('clientName').textContent = client.name || (client.fromContext ? 'Cliente do último “Acessar”' : 'Cliente informado pelo CPF');
    $('clientCpf').textContent = docLabel(client.cpf);
  }

  async function chooseClient(c) {
    client = { cpf: c.cpf, name: c.name || '', fromContext: false };
    await Store.setSelectedClient(client);
    $('clientSearch').value = '';
    closeResults();
    renderClient();
  }

  function closeResults() {
    results = [];
    activeIndex = -1;
    $('clientResults').hidden = true;
    $('clientResults').textContent = '';
    $('clientSearch').setAttribute('aria-expanded', 'false');
    $('clientSearch').removeAttribute('aria-activedescendant');
  }

  function setActive(index) {
    activeIndex = index;
    [...$('clientResults').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === index)));
    const li = $('clientResults').children[index];
    if (li) {
      $('clientSearch').setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  }

  function showResults(list, q, error = '') {
    const ul = $('clientResults');
    ul.textContent = '';
    results = list.slice();
    // CPF válido digitado e fora da lista: dá para usar mesmo assim (a API confere o cadastro)
    const digits = F.onlyDigits(q);
    if (/^[\d.\-/\s]+$/.test(q) && F.isValidCpfCnpj(digits) && !results.some((c) => c.cpf === digits)) results.push({ cpf: digits, name: '', manual: true });
    results.forEach((c, i) => {
      const li = document.createElement('li');
      li.id = `client-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.textContent = c.manual ? `Usar o ${docLabel(c.cpf)}` : c.name || '(sem nome)';
      const cpf = document.createElement('span');
      cpf.className = 'muted';
      cpf.textContent = c.manual ? '' : F.formatCpf(c.cpf);
      li.append(name, cpf);
      // mousedown: antes de o campo perder o foco
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        void chooseClient(c);
      });
      ul.append(li);
    });
    if (!results.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = error || (q ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado.');
      ul.append(li);
    }
    ul.hidden = false;
    $('clientSearch').setAttribute('aria-expanded', 'true');
    activeIndex = -1;
    if (results.length === 1) setActive(0);
  }

  async function runSearch() {
    const q = $('clientSearch').value.trim();
    const seq = ++searchSeq;
    try {
      const list = await api.customers(q, LIMITS.customers);
      if (seq === searchSeq) showResults(list, q);
    } catch (err) {
      if (seq === searchSeq) showResults([], q, errorText(err));
    }
  }

  function bindClient() {
    const input = $('clientSearch');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => void runSearch(), 250); // espera parar de digitar
    });
    input.addEventListener('focus', () => {
      if ($('clientResults').hidden) void runSearch();
    });
    input.addEventListener('blur', () => setTimeout(closeResults, 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + step + results.length) % results.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = results[activeIndex] ?? (results.length === 1 ? results[0] : null);
        if (pick) void chooseClient(pick);
      } else if (e.key === 'Escape' && !$('clientResults').hidden) {
        e.preventDefault();
        closeResults();
      }
    });
    $('clientChange').addEventListener('click', async () => {
      client = null;
      await Store.setSelectedClient(null);
      renderClient();
      input.focus();
    });
  }

  /** Cliente ao abrir: o escolhido antes ou o CPF do último "Acessar" (com o nome buscado na API). */
  async function loadClient() {
    const current = await Store.currentClient();
    if (!current) return renderClient();
    client = { cpf: current.cpf, name: current.name || '', fromContext: current.source === 'context' };
    renderClient();
    if (client.name || !Api.isConfigured(settings)) return;
    try {
      const cpf = client.cpf;
      const found = (await api.customers(cpf, LIMITS.customers)).find((c) => c.cpf === cpf);
      // o usuário pode ter trocado de cliente enquanto a busca corria
      if (found?.name && client && client.cpf === cpf && !client.name) await chooseClient(found);
    } catch {
      /* sem o nome, segue com o CPF */
    }
  }

  function needClient(statusId) {
    setStatus(statusId, 'Escolha o cliente antes de enviar.', 'error');
    if (!client) $('clientSearch').focus();
  }

  // ------------------------------------------------------------------ abas
  const TABS = ['file', 'page', 'status', 'log'];
  function showTab(name) {
    for (const t of TABS) {
      $(`tabbtn-${t}`).setAttribute('aria-selected', String(t === name));
      $(`tab-${t}`).hidden = t !== name;
    }
    if (name === 'page') void loadPage(false);
    if (name === 'log') void renderLog();
  }

  // ------------------------------------------------------------------ enviar arquivo
  function setFiles(list) {
    files = [...list];
    const ul = $('fileList');
    ul.textContent = '';
    ul.hidden = !files.length;
    for (const f of files) {
      const li = document.createElement('li');
      const bad = !f.size || f.size > LIMITS.fileBytes;
      if (bad) li.className = 'bad';
      const name = document.createElement('span');
      name.textContent = f.name;
      name.title = f.name;
      const size = document.createElement('span');
      size.textContent = !f.size ? 'vazio' : f.size > LIMITS.fileBytes ? `${F.formatBytes(f.size)} (passa do limite)` : F.formatBytes(f.size);
      li.append(name, size);
      ul.append(li);
    }
    setStatus('fileStatus', '');
  }

  function bindFile() {
    const drop = $('drop');
    fillSelect($('fileCategory'), S.DOCUMENT_CATEGORIES, { value: S.DEFAULT_DOCUMENT_CATEGORY });
    $('fileYear').value = String(F.currentExerciseYear());
    $('file').addEventListener('change', () => setFiles($('file').files));
    // soltar fora da área não pode trocar o popup pelo arquivo
    for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
    drop.addEventListener('dragover', () => drop.classList.add('over'));
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      drop.classList.remove('over');
      if (e.dataTransfer?.files?.length) setFiles(e.dataTransfer.files);
    });
    $('isPrefilled').addEventListener('change', () => {
      $('fileCategory').disabled = $('isPrefilled').checked; // a pré-preenchida tem lugar próprio no Verifco
    });
    $('openWindow').hidden = inWindow;
    $('openWindow').addEventListener('click', async () => {
      await chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html?janela=1'), type: 'popup', width: 420, height: 700 });
      window.close();
    });

    $('fileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!client) return needClient('fileStatus');
      if (!files.length) return setStatus('fileStatus', 'Escolha um arquivo.', 'error');
      const prefilled = $('isPrefilled').checked;
      const yearText = $('fileYear').value.trim();
      const year = F.parseYear(yearText);
      if (yearText && !year) return setStatus('fileStatus', 'Informe o exercício com 4 dígitos (ex.: 2026).', 'error');
      if (prefilled && !year) return setStatus('fileStatus', 'Informe o exercício da pré-preenchida.', 'error');
      const form = $('fileForm');
      const progress = $('fileProgress');
      busy(form, true);
      progress.hidden = false;
      const sending = files.slice();
      const failed = [];
      let last = null;
      for (const [i, file] of sending.entries()) {
        if (sending.length > 1) progress.value = i / sending.length;
        else progress.removeAttribute('value'); // um arquivo só: barra sem porcentagem
        setStatus('fileStatus', `Enviando ${sending.length > 1 ? `${i + 1} de ${sending.length}: ` : ''}${file.name}… Mantenha esta janela aberta.`);
        last = await actions.sendFile({ client, file, filename: file.name, year, category: $('fileCategory').value, prefilled, maxBytes: LIMITS.fileBytes });
        if (!last.ok) failed.push({ file, error: last.error });
      }
      progress.hidden = true;
      busy(form, false);
      if (!failed.length) {
        setFiles([]);
        $('file').value = '';
        setStatus('fileStatus', sending.length > 1 ? `${sending.length} arquivos enviados.` : last.message, 'ok');
      } else {
        setFiles(failed.map((f) => f.file)); // ficam só os que falharam, para tentar de novo
        const sent = sending.length - failed.length;
        setStatus('fileStatus', sending.length > 1 ? `${sent} de ${sending.length} enviados. ${failed[0].file.name}: ${failed[0].error}` : failed[0].error, 'error');
      }
    });
  }

  // ------------------------------------------------------------------ registrar esta página
  function fillPage(info) {
    $('pageTitle').value = page.title;
    $('pageUrl').textContent = page.url;
    $('pageUrl').title = page.url;
    $('pageText').value = page.text;
    $('pageInfo').textContent = info;
    $('pageTextInfo').textContent = `(${page.text.length} caracteres)`;
    $('pageSend').disabled = false;
  }

  /** Lê a aba ativa (ou usa a seleção deixada pelo menu de contexto). */
  async function loadPage(force) {
    if (page && !force) return;
    setStatus('pageStatus', '');
    const draft = force ? null : await Store.getDraft();
    if (force) await Store.setDraft(null);
    if (draft) {
      page = { title: draft.title ?? '', url: draft.url ?? '', text: draft.text ?? '', fromSelection: true, truncated: Boolean(draft.truncated) };
      pageIsDraft = true;
      $('pageShotRow').hidden = true;
      return fillPage('Texto que você selecionou e mandou pelo menu. Confira o cliente e clique em “Registrar página”.');
    }
    pageIsDraft = false;
    page = null;
    $('pageSend').disabled = true;
    $('pageShotRow').hidden = inWindow;
    if (inWindow) {
      $('pageInfo').textContent = 'Nesta janela não há página para ler. Abra a página, clique no ícone do Verifco e use a aba “Página”.';
      $('pageReload').disabled = true;
      return;
    }
    $('pageInfo').textContent = 'Lendo a página…';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined) throw new Error('Aba não encontrada.');
      pageTab = tab;
      page = await Capture.captureTab(tab.id, LIMITS.pageTextChars);
      fillPage(
        page.fromSelection
          ? 'Vai o texto que você selecionou na página.'
          : page.truncated
            ? `Vai o texto visível da página, cortado em ${LIMITS.pageTextChars} caracteres. Selecione um trecho na página para mandar só ele.`
            : 'Vai o texto visível da página. Selecione um trecho na página para mandar só ele.',
      );
    } catch (err) {
      $('pageInfo').textContent = '';
      setStatus('pageStatus', errorText(err), 'error');
    }
  }

  function bindPage() {
    $('pageText').maxLength = LIMITS.pageTextChars;
    $('pageText').addEventListener('input', () => {
      $('pageTextInfo').textContent = `(${$('pageText').value.length} caracteres)`;
    });
    $('pageReload').addEventListener('click', () => void loadPage(true));
    $('pageForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!page) return setStatus('pageStatus', 'Não há página lida para registrar.', 'error');
      if (!client) return needClient('pageStatus');
      const form = $('pageForm');
      busy(form, true);
      setStatus('pageStatus', 'Enviando…');
      try {
        let screenshot = null;
        if ($('pageShot').checked && !pageIsDraft && !inWindow) {
          try {
            screenshot = await Capture.captureScreenshot(pageTab?.windowId, LIMITS.base64Chars);
          } catch (err) {
            return setStatus('pageStatus', `Não foi possível capturar a imagem da tela (${errorText(err)}). Desmarque “Anexar imagem da tela” para enviar só o texto.`, 'error');
          }
        }
        const sent = { title: $('pageTitle').value.trim() || page.title, url: page.url, text: $('pageText').value.trim(), fromSelection: page.fromSelection, truncated: page.truncated };
        const res = await actions.registerPage({ client, page: sent, screenshot });
        if (res.ok && pageIsDraft) await Store.setDraft(null);
        setStatus('pageStatus', res.ok ? `${res.message} Cliente: ${client.name || docLabel(client.cpf)}.` : res.error, res.ok ? 'ok' : 'error');
      } finally {
        busy(form, false);
        if (inWindow && !pageIsDraft) $('pageReload').disabled = true;
      }
    });
  }

  // ------------------------------------------------------------------ situação da declaração e CND
  function bindStatus() {
    fillSelect($('declStatus'), S.DECLARATION_STATUS, { placeholder: 'Selecione…' });
    fillSelect($('cndStatus'), S.CND_STATUS, { placeholder: 'Selecione…' });
    $('declYear').value = String(F.currentExerciseYear());

    $('declForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!client) return needClient('declStatusMsg');
      busy($('declForm'), true);
      setStatus('declStatusMsg', 'Enviando…');
      const res = await actions.sendDeclarationStatus({ client, year: $('declYear').value.trim(), status: $('declStatus').value, receiptNumber: $('declReceipt').value });
      busy($('declForm'), false);
      setStatus('declStatusMsg', res.ok ? res.message : res.error, res.ok ? 'ok' : 'error');
    });

    $('cndForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!client) return needClient('cndStatusMsg');
      busy($('cndForm'), true);
      setStatus('cndStatusMsg', 'Enviando…');
      const res = await actions.sendCnd({ client, status: $('cndStatus').value, validUntil: $('cndValidUntil').value, code: $('cndCode').value });
      busy($('cndForm'), false);
      setStatus('cndStatusMsg', res.ok ? res.message : res.error, res.ok ? 'ok' : 'error');
    });
  }

  // ------------------------------------------------------------------ últimos envios
  async function renderLog() {
    const list = await Store.getLog();
    const ul = $('logList');
    ul.textContent = '';
    $('logEmpty').hidden = list.length > 0;
    $('logClear').hidden = !list.length;
    const now = new Date();
    for (const item of list) {
      const li = document.createElement('li');
      if (!item.ok) li.className = 'error';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = item.ok ? '✓' : '!';
      mark.title = item.ok ? 'Enviado' : 'Erro';
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = item.what;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [F.formatWhen(item.at, now), item.name, item.cpf].filter(Boolean).join(' · ');
      li.append(mark, what, meta);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = item.ok ? item.detail : `Erro: ${item.detail}`;
        li.append(detail);
      }
      ul.append(li);
    }
  }

  // ------------------------------------------------------------------ configuração
  /**
   * Pede ao navegador acesso só aos endereços informados. Precisa ser a primeira chamada
   * assíncrona do clique (o Chrome exige o gesto do usuário); se já houver permissão, o
   * navegador responde `true` sem perguntar.
   */
  function requestOrigins(origins) {
    const patterns = [...new Set(origins.filter(Boolean).map((o) => `${o}/*`))];
    return patterns.length ? chrome.permissions.request({ origins: patterns }) : Promise.resolve(true);
  }

  function fillConfig() {
    $('webUrl').value = settings.webUrl;
    $('apiUrl').value = settings.apiUrl;
    $('token').value = settings.token;
  }

  const configDirty = () =>
    $('webUrl').value.trim().replace(/\/$/, '') !== settings.webUrl || $('apiUrl').value.trim().replace(/\/$/, '') !== settings.apiUrl || $('token').value.trim() !== settings.token;

  function bindConfig() {
    $('configForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const webUrl = $('webUrl').value.trim();
      const apiUrl = $('apiUrl').value.trim();
      const token = $('token').value.trim();
      const webOrigin = F.originOf(webUrl);
      if (!webOrigin) return setStatus('configStatus', 'Informe o endereço do Verifco (http:// ou https://).', 'error');
      if (apiUrl && !F.originOf(apiUrl)) return setStatus('configStatus', 'Endereço da API inválido.', 'error');
      if (token && !/^vfk_[A-Za-z0-9_-]{20,}$/.test(token)) return setStatus('configStatus', 'O token deve começar com vfk_.', 'error');
      let granted = false;
      try {
        granted = await requestOrigins([webOrigin, F.originOf(apiUrl)]);
      } catch (err) {
        return setStatus('configStatus', `Não foi possível pedir a permissão: ${errorText(err)}`, 'error');
      }
      if (!granted) return setStatus('configStatus', 'Sem permissão para acessar o endereço informado.', 'error');
      settings = { webUrl: webOrigin, apiUrl: F.originOf(apiUrl) ?? '', token };
      await Store.saveSettings(settings);
      fillConfig();
      await chrome.runtime.sendMessage({ kind: 'settings-changed' });
      setStatus('configStatus', 'Configuração salva. Recarregue a página do Verifco.', 'ok');
      void checkConnection();
    });

    $('test').addEventListener('click', async () => {
      if (configDirty()) return setStatus('configStatus', 'Salve a configuração antes de testar.', 'error');
      const btn = $('test');
      btn.disabled = true;
      setStatus('configStatus', 'Testando…');
      try {
        const res = await chrome.runtime.sendMessage({ kind: 'test-connection' });
        if (res?.ok) setStatus('configStatus', `Conectado a ${res.who.office.name} (token “${res.who.token.name}”).`, 'ok');
        else setStatus('configStatus', res?.error ?? 'Falha na conexão.', 'error');
      } catch (err) {
        setStatus('configStatus', errorText(err), 'error');
      } finally {
        btn.disabled = false;
      }
      void checkConnection();
    });
  }

  // ------------------------------------------------------------------ início
  async function init() {
    document.body.classList.toggle('window', inWindow);
    $('version').textContent = `v${version}`;
    for (const t of TABS) $(`tabbtn-${t}`).addEventListener('click', () => showTab(t));
    $('logClear').addEventListener('click', async () => {
      await Store.clearLog();
      await renderLog();
    });
    bindClient();
    bindFile();
    bindPage();
    bindStatus();
    bindConfig();

    void Store.clearBadge(); // o selo do ícone vale até o usuário abrir o popup
    settings = await Store.getSettings();
    fillConfig();
    void checkConnection();
    await loadClient();
    // seleção mandada pelo menu de contexto sem cliente escolhido: termina o envio aqui
    if (await Store.getDraft()) showTab('page');
  }

  void init();
})();
