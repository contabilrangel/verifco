// Leitura genérica da página (lib/capture.js). Rodar: node --test (em apps/extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/format.js';
import '../lib/capture.js';

const C = globalThis.VerifcoCapture;

/** Roda collectPage como o navegador faz: só o texto da função, com uma página de mentira. */
function runInPage({ selection = '', bodyText = '', title = 'Título', href = 'https://x.gov.br/p', width = 1200, height = 800 }, maxChars) {
  const fn = new Function('window', 'document', 'location', `return (${C.collectPage.toString()})(${maxChars});`);
  return fn({ getSelection: () => ({ toString: () => selection }), innerWidth: width, innerHeight: height }, { title, body: { innerText: bodyText } }, { href });
}

test('collectPage funciona sozinha (sem nada de fora) e prefere a seleção', () => {
  const page = runInPage({ bodyText: 'Linha 1   \n\n\n\nLinha 2\t fim' }, 100);
  assert.deepEqual(page, { title: 'Título', url: 'https://x.gov.br/p', selection: '', text: 'Linha 1\n\nLinha 2 fim', visible: true });
  const sel = runInPage({ selection: '  trecho  escolhido ', bodyText: 'resto da página' }, 100);
  assert.equal(sel.selection, 'trecho escolhido');
  assert.equal(sel.text, '');
});

test('collectPage limita o texto e marca quadro invisível', () => {
  const page = runInPage({ bodyText: 'a'.repeat(500), width: 0, height: 0 }, 100);
  assert.equal(page.text.length, 101); // um a mais, para saber que foi cortado
  assert.equal(page.visible, false);
});

test('mergeFrames: quadro principal + quadros visíveis', () => {
  const page = C.mergeFrames(
    [
      { top: false, title: 'Serviço', url: 'https://www3.x/servico', selection: '', text: 'Conteúdo do serviço', visible: true },
      { top: true, title: '  eCAC \n Portal ', url: 'https://cav.x/ecac/', selection: '', text: 'Menu do portal', visible: true },
      { top: false, title: '', url: 'about:blank', selection: '', text: 'rastreador', visible: false },
    ],
    8000,
  );
  assert.deepEqual(page, { title: 'eCAC Portal', url: 'https://cav.x/ecac/', text: 'Menu do portal\n\nConteúdo do serviço', fromSelection: false, truncated: false });
});

test('mergeFrames: seleção de qualquer quadro tem preferência; corta no limite', () => {
  const sel = C.mergeFrames(
    [
      { top: true, title: 'T', url: 'u', selection: '', text: 'página inteira', visible: true },
      { top: false, title: '', url: 'f', selection: 'só isto', text: '', visible: true },
    ],
    8000,
  );
  assert.equal(sel.text, 'só isto');
  assert.equal(sel.fromSelection, true);
  const cut = C.mergeFrames([{ top: true, title: 'T', url: 'u', selection: '', text: 'x'.repeat(50), visible: true }], 20);
  assert.equal(cut.text.length, 20);
  assert.equal(cut.truncated, true);
  assert.equal(C.mergeFrames([], 10), null);
});

test('splitDataUrl', () => {
  assert.deepEqual(C.splitDataUrl('data:image/png;base64,iVBORw0KGgo='), { mimeType: 'image/png', base64: 'iVBORw0KGgo=' });
  assert.deepEqual(C.splitDataUrl('data:image/JPEG;base64,/9j/4AAQ'), { mimeType: 'image/jpeg', base64: '/9j/4AAQ' });
  assert.equal(C.splitDataUrl('data:image/png;base64,'), null);
  assert.equal(C.splitDataUrl('https://x/y.png'), null);
  assert.equal(C.splitDataUrl(undefined), null);
});

test('buildPageRecord: registro "other" com título, texto, endereço e anexo opcional', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  const rec = C.buildPageRecord({ cpf: '529.982.247-25', title: ' Extrato \n', url: 'https://x.gov.br/p', text: 'conteúdo', fromSelection: false, truncated: true, now });
  assert.deepEqual(rec, {
    kind: 'other',
    cpf: '52998224725',
    data: { title: 'Extrato', text: 'conteúdo', url: 'https://x.gov.br/p', origin: 'page', truncated: true, capturedAt: '2026-11-11T12:00:00.000Z' },
  });
  const withShot = C.buildPageRecord({ cpf: '52998224725', title: '', url: '', text: 't', fromSelection: true, screenshot: { filename: 'tela.png', mimeType: 'image/png', base64: 'AAAA' }, now });
  assert.equal(withShot.data.title, 'Página registrada pela extensão');
  assert.equal(withShot.data.origin, 'selection');
  assert.deepEqual(withShot.file, { filename: 'tela.png', mimeType: 'image/png', base64: 'AAAA' });
});

test('captureScreenshot: PNG; se passar do limite, JPEG; nome com data e hora', async () => {
  const asked = [];
  globalThis.chrome = {
    tabs: {
      captureVisibleTab: async (_windowId, opts) => {
        asked.push(opts.format);
        return opts.format === 'png' ? `data:image/png;base64,${'A'.repeat(100)}` : `data:image/jpeg;base64,${'B'.repeat(10)}`;
      },
    },
  };
  try {
    const now = new Date(2026, 10, 11, 9, 5, 7);
    const png = await C.captureScreenshot(1, 1000, now);
    assert.deepEqual(png, { filename: 'tela-20261111-090507.png', mimeType: 'image/png', base64: 'A'.repeat(100) });
    const jpg = await C.captureScreenshot(1, 50, now);
    assert.equal(jpg.mimeType, 'image/jpeg');
    assert.equal(jpg.filename, 'tela-20261111-090507.jpg');
    assert.deepEqual(asked, ['png', 'png', 'jpeg']);
    await assert.rejects(C.captureScreenshot(1, 5, now), /grande demais/);
  } finally {
    delete globalThis.chrome;
  }
});

test('captureTab: tenta todos os quadros, cai para o principal, explica quando não pode ler', async () => {
  const frame = { title: 'T', url: 'https://x/', selection: '', text: 'texto', visible: true };
  const targets = [];
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ target }) => {
        targets.push(target);
        if (target.allFrames) throw new Error('Cannot access contents of the page');
        return [{ frameId: 0, result: frame }];
      },
    },
  };
  try {
    const page = await C.captureTab(7, 8000);
    assert.equal(page.text, 'texto');
    assert.deepEqual(targets, [{ tabId: 7, allFrames: true }, { tabId: 7 }]);
    globalThis.chrome.scripting.executeScript = async () => {
      throw new Error('Cannot access a chrome:// URL');
    };
    await assert.rejects(C.captureTab(7, 8000), /não deixa ler esta página/);
  } finally {
    delete globalThis.chrome;
  }
});
