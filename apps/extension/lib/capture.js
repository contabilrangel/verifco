/*
 * "Registrar esta página": leitura genérica da aba (título, endereço, texto selecionado ou texto
 * visível) e imagem da tela. Não conhece nenhuma página em particular: o HTML do eCAC não é
 * público nem estável, então nada aqui depende de seletores.
 * Script clássico: define `globalThis.VerifcoCapture`. Depende de lib/format.js.
 * Usado pelo popup e pelo service worker (botão do aviso e menu de contexto).
 */
(function () {
  const F = globalThis.VerifcoFormat;
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /**
   * Roda DENTRO da página, em cada quadro (chrome.scripting.executeScript): é enviada como texto,
   * então não pode usar nada definido fora dela.
   */
  function collectPage(maxChars) {
    const clean = (s) =>
      String(s ?? '')
        .replace(/\r/g, '')
        .replace(/[ \t ]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    let selection = '';
    try {
      selection = clean(String(window.getSelection() ?? ''));
    } catch {
      selection = '';
    }
    let text = '';
    if (!selection) {
      try {
        // innerText = o que está visível (ignora o que a página esconde com CSS)
        text = clean(document.body ? document.body.innerText : '');
      } catch {
        text = '';
      }
    }
    return {
      title: String(document.title ?? ''),
      url: String(location.href),
      selection: selection.slice(0, maxChars + 1),
      text: text.slice(0, maxChars + 1),
      visible: window.innerWidth > 1 && window.innerHeight > 1,
    };
  }

  /**
   * Junta o resultado dos quadros da aba: título e endereço do quadro principal; a seleção de
   * qualquer quadro tem preferência; sem seleção, o texto do principal seguido dos quadros
   * visíveis (o eCAC abre os serviços dentro de um quadro).
   */
  function mergeFrames(frames, maxChars) {
    const list = (frames ?? []).filter(Boolean);
    const top = list.find((f) => f.top) ?? list[0];
    if (!top) return null;
    const selections = list.map((f) => f.selection).filter(Boolean);
    const fromSelection = selections.length > 0;
    const parts = fromSelection ? selections : [top.text, ...list.filter((f) => f !== top && f.visible).map((f) => f.text)].filter(Boolean);
    const { text, truncated } = F.truncateText(parts.join('\n\n'), maxChars);
    return { title: oneLine(top.title).slice(0, 200), url: String(top.url ?? ''), text, fromSelection, truncated };
  }

  /** Lê a aba. Exige acesso à página (activeTab pelo clique do usuário ou permissão do site). */
  async function captureTab(tabId, maxChars) {
    const run = (target) => chrome.scripting.executeScript({ target, func: collectPage, args: [maxChars] });
    let results;
    try {
      results = await run({ tabId, allFrames: true });
    } catch {
      try {
        results = await run({ tabId });
      } catch {
        throw new Error('O navegador não deixa ler esta página (página interna do navegador, loja de extensões ou PDF aberto na aba). Se for um PDF, baixe o arquivo e use “Enviar arquivo”.');
      }
    }
    const page = mergeFrames(
      (results ?? []).filter((r) => r && r.result).map((r) => ({ ...r.result, top: r.frameId === 0 })),
      maxChars,
    );
    if (!page) throw new Error('Não foi possível ler esta página.');
    return page;
  }

  /** "data:image/png;base64,AAAA" → { mimeType, base64 } ou null. */
  function splitDataUrl(dataUrl) {
    const m = /^data:([^;,]+)((?:;[^;,]+)*?);base64,(.*)$/s.exec(String(dataUrl ?? ''));
    return m && m[3] ? { mimeType: m[1].toLowerCase(), base64: m[3] } : null;
  }

  const stamp = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  /**
   * Imagem da parte visível da aba ativa da janela, pronta para ir como anexo do registro.
   * PNG; se passar do limite do anexo, tenta JPEG. Exige activeTab (clique do usuário na extensão).
   */
  async function captureScreenshot(windowId, maxBase64Chars, now = new Date()) {
    let shot = splitDataUrl(await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }));
    if (shot && shot.base64.length > maxBase64Chars) shot = splitDataUrl(await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }));
    if (!shot) throw new Error('O navegador não devolveu a imagem da tela.');
    if (shot.base64.length > maxBase64Chars) throw new Error('A imagem da tela ficou grande demais para enviar.');
    return { filename: `tela-${stamp(now)}.${shot.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`, mimeType: shot.mimeType, base64: shot.base64 };
  }

  /** Registro `other` de POST /api/sync/ecac-records para uma página ou seleção. */
  function buildPageRecord({ cpf, title, url, text, fromSelection, truncated, screenshot, now = new Date() }) {
    const record = {
      kind: 'other',
      cpf: F.onlyDigits(cpf),
      data: {
        title: oneLine(title).slice(0, 200) || 'Página registrada pela extensão',
        text: String(text ?? ''),
        url: String(url ?? '').slice(0, 2000),
        origin: fromSelection ? 'selection' : 'page',
        truncated: Boolean(truncated),
        capturedAt: now.toISOString(),
      },
    };
    if (screenshot) record.file = { filename: screenshot.filename, mimeType: screenshot.mimeType, base64: screenshot.base64 };
    return record;
  }

  globalThis.VerifcoCapture = { collectPage, mergeFrames, captureTab, splitDataUrl, captureScreenshot, buildPageRecord };
})();
