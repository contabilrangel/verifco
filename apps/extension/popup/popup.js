/* Popup: endereço do Verifco, token vfk_ e captura (parsers). */
(function () {
  const { STORAGE, originOf } = globalThis.VerifcoConfig;
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = `status ${kind}`;
  };
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const parserList = globalThis.VerifcoCapture.list();

  async function load() {
    const data = await chrome.storage.local.get(STORAGE.settings);
    const s = data[STORAGE.settings] ?? {};
    $('webUrl').value = s.webUrl ?? '';
    $('apiUrl').value = s.apiUrl ?? '';
    $('token').value = s.token ?? '';
    $('captureEnabled').checked = Boolean(s.captureEnabled);
    const enabled = new Set(s.enabledParsers ?? []);
    const box = $('parsers');
    box.textContent = '';
    for (const p of parserList) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = p.id;
      input.checked = enabled.has(p.id);
      label.append(input, document.createTextNode(` ${p.description || p.id}`));
      box.append(label);
    }
  }

  /**
   * Pede ao navegador acesso só aos endereços informados. Precisa ser a primeira chamada
   * assíncrona do clique (o Chrome exige o gesto do usuário); se já houver permissão, o
   * navegador responde `true` sem perguntar.
   */
  function requestOrigins(origins) {
    const patterns = [...new Set(origins.filter(Boolean).map((o) => `${o}/*`))];
    return patterns.length ? chrome.permissions.request({ origins: patterns }) : Promise.resolve(true);
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const webUrl = $('webUrl').value.trim().replace(/\/$/, '');
    const apiUrl = $('apiUrl').value.trim().replace(/\/$/, '');
    const token = $('token').value.trim();
    const webOrigin = originOf(webUrl);
    if (!webOrigin) return setStatus('Informe o endereço do Verifco (http:// ou https://).', 'error');
    if (apiUrl && !originOf(apiUrl)) return setStatus('Endereço da API inválido.', 'error');
    if (token && !/^vfk_[A-Za-z0-9_-]{20,}$/.test(token)) return setStatus('O token deve começar com vfk_.', 'error');
    let granted = false;
    try {
      granted = await requestOrigins([webOrigin, originOf(apiUrl)]);
    } catch (err) {
      return setStatus(`Não foi possível pedir a permissão: ${err instanceof Error ? err.message : err}`, 'error');
    }
    if (!granted) return setStatus('Sem permissão para acessar o endereço informado.', 'error');
    const enabledParsers = [...document.querySelectorAll('#parsers input:checked')].map((i) => i.value);
    await chrome.storage.local.set({
      [STORAGE.settings]: { webUrl: webOrigin, apiUrl: originOf(apiUrl) ?? '', token, captureEnabled: $('captureEnabled').checked, enabledParsers },
    });
    await chrome.runtime.sendMessage({ kind: 'settings-changed' });
    setStatus('Configuração salva. Recarregue a página do Verifco.', 'ok');
  });

  $('test').addEventListener('click', async () => {
    const btn = $('test');
    btn.disabled = true;
    setStatus('Testando…');
    try {
      const res = await chrome.runtime.sendMessage({ kind: 'test-connection' });
      if (res?.ok) setStatus(`Conectado a ${res.who.office.name} (token “${res.who.token.name}”).`, 'ok');
      else setStatus(res?.error ?? 'Falha na conexão.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  void load();
})();
