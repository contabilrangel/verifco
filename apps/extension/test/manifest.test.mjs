// Confere o pacote: manifest válido, arquivos citados existem, todo .js passa em `node --check`
// e as chaves/rótulos copiados em lib/statuses.js batem com o pacote compartilhado (quando a
// extensão está dentro do monorepo). Rodar: node --test (em apps/extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/statuses.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

/** Todos os arquivos da pasta com a extensão pedida (sem node_modules). */
function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, ext, out);
    else if (entry.name.endsWith(ext)) out.push(relative(root, abs));
  }
  return out;
}

/** Padrão de endereço do Chrome: <esquema>://<host>/<caminho>; "*" no host só no começo. */
const MATCH_PATTERN = /^(\*|https?):\/\/(\*|(\*\.)?[^/*:]+)\/.*$/;

test('manifest: MV3, versão, descrição e permissões', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length <= 132, `descrição com ${manifest.description.length} caracteres (máximo 132)`);
  const allowed = new Set(['storage', 'scripting', 'activeTab', 'contextMenus', 'notifications']);
  for (const p of manifest.permissions) assert.ok(allowed.has(p), `permissão inesperada: ${p}`);
  assert.equal(new Set(manifest.permissions).size, manifest.permissions.length);
  // toda permissão pedida é usada no código
  const code = walk(root, '.js').filter((f) => !f.startsWith('test')).map(read).join('\n');
  const uses = { storage: 'chrome.storage.', scripting: 'chrome.scripting.', contextMenus: 'chrome.contextMenus.', notifications: 'chrome.notifications.', activeTab: 'captureVisibleTab' };
  for (const p of manifest.permissions) assert.ok(code.includes(uses[p]), `permissão sem uso: ${p}`);
});

test('manifest: padrões de endereço válidos e sem acesso amplo fixo', () => {
  const patterns = [...manifest.host_permissions, ...manifest.optional_host_permissions, ...manifest.content_scripts.flatMap((c) => c.matches)];
  for (const p of patterns) assert.match(p, MATCH_PATTERN, p);
  // acesso a qualquer site só como opcional (pedido para o endereço do Verifco)
  for (const p of manifest.host_permissions) assert.ok(!/^[^:]+:\/\/\*\//.test(p), `host amplo demais: ${p}`);
  // o aviso roda nos mesmos sites para os quais há permissão (ler os quadros, baixar links)
  const banner = manifest.content_scripts.find((c) => c.js.includes('content/ecac.js'));
  assert.deepEqual(banner.matches, manifest.host_permissions);
});

test('manifest: todo arquivo citado existe', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    ...(manifest.options_ui?.page ? [manifest.options_ui.page] : []),
  ];
  for (const f of files) assert.ok(existsSync(join(root, f)), `não existe: ${f}`);
});

test('service worker e páginas: scripts e estilos citados existem', () => {
  const sw = read(manifest.background.service_worker);
  const imported = [...sw.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.ok(imported.length > 0);
  for (const f of imported) assert.ok(existsSync(join(root, f)), `importScripts: não existe ${f}`);
  // arquivos registrados em tempo de execução (ponte no endereço configurado)
  for (const m of sw.matchAll(/js:\s*\[([^\]]*)\]/g)) {
    for (const x of m[1].matchAll(/'([^']+)'/g)) assert.ok(existsSync(join(root, x[1])), `registerContentScripts: não existe ${x[1]}`);
  }
  for (const html of walk(root, '.html')) {
    const text = read(html);
    const refs = [...text.matchAll(/<(?:script|img)[^>]*\ssrc="([^"]+)"/g), ...text.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, html);
    for (const ref of refs) assert.ok(existsSync(join(root, dirname(html), ref)), `${html}: não existe ${ref}`);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(text), `${html}: script embutido não roda em extensão MV3`);
  }
});

test('popup: todo id usado no script existe no HTML', () => {
  const html = read('popup/popup.html');
  const js = read('popup/popup.js');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  for (const id of used) assert.ok(ids.has(id), `popup.js usa #${id}, que não existe em popup.html`);
  for (const t of ['file', 'page', 'status', 'log']) assert.ok(ids.has(`tab-${t}`) && ids.has(`tabbtn-${t}`), `aba ${t}`);
});

test('todo .js passa em node --check', () => {
  const files = walk(root, '.js');
  assert.ok(files.length >= 8);
  for (const f of files) execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
});

test('lib/statuses.js acompanha o pacote compartilhado', (t) => {
  const shared = join(root, '..', '..', 'packages', 'shared', 'src');
  if (!existsSync(join(shared, 'enums.ts'))) return t.skip('fora do monorepo: sem packages/shared para comparar');
  /** Lê `export const NOME = { chave: 'rótulo', ... } as const;` do TypeScript. */
  const mapOf = (file, name) => {
    const block = new RegExp(`export const ${name} = \\{([^}]*)\\} as const;`).exec(readFileSync(join(shared, file), 'utf8'));
    assert.ok(block, `${name} não encontrado em ${file}`);
    return Object.fromEntries([...block[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
  };
  const S = globalThis.VerifcoStatuses;
  assert.deepEqual(S.DECLARATION_STATUS, mapOf('enums.ts', 'ECAC_DECLARATION_STATUS'));
  assert.deepEqual(S.CND_STATUS, mapOf('enums.ts', 'CND_STATUS'));
  assert.deepEqual(S.DOCUMENT_CATEGORIES, mapOf('customer-documents.ts', 'DOCUMENT_CATEGORIES'));
  assert.ok(S.DEFAULT_DOCUMENT_CATEGORY in S.DOCUMENT_CATEGORIES);
});
