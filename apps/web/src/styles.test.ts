// @vitest-environment node
import { describe, expect, it } from 'vitest';
import postcss, { type Rule } from 'postcss';

/**
 * Os CSS da web são globais: ds/ e app/ valem para tudo, e cada módulo
 * (modules/<nome>/*.css) é carregado junto com os demais. Estes testes impedem
 * CSS inválido (uma chave sem fechar derruba o build e a aplicação inteira) e
 * classes com o mesmo nome em módulos diferentes (o último carregado vence).
 */

// Lê os arquivos do disco: o import "?raw" de .css volta vazio no Vitest (o CSS é desligado nos testes).
// O especificador fica numa variável porque a web não tem os tipos do Node.
const NODE_FS: string = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync: (path: URL, encoding: 'utf8') => string };
const read = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, readFileSync(new URL(k, import.meta.url), 'utf8')]));

// import.meta.glob sem "eager" só lista os caminhos (relativos a src/), sem carregar nada
const CSS = read(Object.keys(import.meta.glob('./**/*.css')));
const SOURCES = read(Object.keys(import.meta.glob(['./**/*.tsx', './**/*.ts', '!./**/*.test.ts', '!./**/*.test.tsx'])));

const moduleOf = (path: string) => /^\.\/modules\/([^/]+)\//.exec(path)?.[1] ?? null;
const isShared = (path: string) => path.startsWith('./ds/') || path.startsWith('./app/');
const classesIn = (selector: string) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

interface Sheet {
  path: string;
  rules: Rule[];
}
/** Erros de sintaxe por arquivo (verificados no primeiro teste; os demais usam o que foi possível ler). */
const parseErrors: string[] = [];
const sheets: Sheet[] = Object.entries(CSS).map(([path, css]) => {
  const rules: Rule[] = [];
  try {
    postcss.parse(css, { from: path }).walkRules((r) => {
      // seletores de @keyframes (from, to, 50%) não são classes
      if (r.parent?.type === 'atrule' && /keyframes$/i.test((r.parent as { name: string }).name)) return;
      rules.push(r);
    });
  } catch (e) {
    parseErrors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { path, rules };
});

/** Classes definidas pelo design system e pelo shell (podem ser usadas e ajustadas, com escopo, pelos módulos). */
const shared = new Set(sheets.filter((s) => isShared(s.path)).flatMap((s) => s.rules.flatMap((r) => r.selectors.flatMap(classesIn))));

/** Classes de cada módulo: as que aparecem no CSS do módulo e não são do design system. */
const owned = new Map<string, Set<string>>();
for (const s of sheets) {
  const mod = moduleOf(s.path);
  if (!mod) continue;
  const set = owned.get(mod) ?? new Set<string>();
  for (const r of s.rules) for (const c of r.selectors.flatMap(classesIn)) if (!shared.has(c)) set.add(c);
  owned.set(mod, set);
}

describe('CSS da web', () => {
  it('lê o conteúdo real dos arquivos (sanidade do próprio teste)', () => {
    expect(CSS['./ds/ds.css']).toContain('.vf-btn');
    expect(shared.has('vf-tabs')).toBe(true);
    expect(owned.get('advisory')?.has('vf-adv-kpi')).toBe(true);
    expect(owned.get('declarations')?.has('vf-dec-kpi')).toBe(true);
    expect(SOURCES['./app/Shell.tsx']).toContain('FavoritesNav');
  });

  it('todos os arquivos .css são CSS válido (PostCSS)', () => {
    expect(Object.keys(CSS).length).toBeGreaterThan(5);
    expect(parseErrors).toEqual([]);
  });

  it('detecta bloco sem fechar, como o da mesclagem que quebrou o ds.css', () => {
    expect(() => postcss.parse('@media (max-width: 600px) {\n  .a { color: red; }\n.b { color: blue; }')).toThrow(/Unclosed block/);
  });

  it('o design system não carrega CSS de módulo (integrações, financeiro, eCAC ficam nos módulos)', () => {
    const ds = sheets.find((s) => s.path === './ds/ds.css')!;
    const leaked = ds.rules.flatMap((r) => r.selectors.flatMap(classesIn)).filter((c) => /^vf-(int|fin|ecac|adv|dec|cus)-/.test(c));
    expect(leaked).toEqual([]);
  });

  it('nenhuma classe é definida em dois módulos diferentes', () => {
    const where = new Map<string, string[]>();
    for (const [mod, set] of owned) for (const c of set) where.set(c, [...(where.get(c) ?? []), mod]);
    const dup = [...where].filter(([, mods]) => mods.length > 1).map(([c, mods]) => `.${c} (${mods.join(', ')})`);
    expect(dup).toEqual([]);
  });

  it('CSS de módulo só altera o design system com escopo do próprio módulo', () => {
    // ".vf-kanban { ... }" num módulo muda o Kanban de todas as telas; ".vf-dec-board .vf-kanban__col" não.
    const global: string[] = [];
    for (const s of sheets) {
      if (!moduleOf(s.path)) continue;
      for (const r of s.rules) {
        for (const sel of r.selectors) {
          const cls = classesIn(sel);
          if (cls.length && cls.every((c) => shared.has(c))) global.push(`${s.path}: ${sel}`);
        }
      }
    }
    expect(global).toEqual([]);
  });

  it('um módulo não usa classes que só existem no CSS de outro módulo', () => {
    const misuse: string[] = [];
    for (const [path, src] of Object.entries(SOURCES)) {
      const mod = moduleOf(path);
      for (const [other, set] of owned) {
        if (other === mod) continue;
        for (const c of set) if (new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(src)) misuse.push(`${path} usa .${c} de ${other}`);
      }
    }
    expect(misuse).toEqual([]);
  });

  it('nenhuma tela usa gridColumn em linha: vf-span-2, vf-span-3, vf-span-full ou a prop span', () => {
    // "span N" em linha cria colunas extras na grade de uma coluna do celular; "1 / -1" tem a classe vf-span-full
    const inline = Object.entries(SOURCES)
      .filter(([, src]) => /\bgridColumn(Start|End)?\s*:/.test(src))
      .map(([p]) => p);
    expect(inline).toEqual([]);
    expect(/\bgridColumn\s*:/.test("style={{ gridColumn: '1 / -1' }}")).toBe(true);
  });

  it('design system: grade aninhada, vf-span-full e ícone da área de envio', () => {
    const ds = postcss.parse(CSS['./ds/ds.css']);
    // --grid-template registrado sem herança: uma .vf-grid dentro de outra não herda as proporções
    const registered: Record<string, string> = {};
    ds.walkAtRules('property', (at) => {
      if (at.params.trim() !== '--grid-template') return;
      at.walkDecls((d) => {
        registered[d.prop] = d.value;
      });
    });
    expect(registered).toMatchObject({ inherits: 'false' });
    // vf-span-full (1 / -1) não volta a "auto" no celular: vale também em grades de duas colunas fixas
    const resets: string[] = [];
    ds.walkAtRules('media', (at) => at.walkRules((r) => r.selectors.forEach((s) => s.includes('vf-span-full') && resets.push(s))));
    expect(resets).toEqual([]);
    // o ícone grande da área de envio não pinta o ícone do botão "Selecionar"
    const selectors = sheets.find((s) => s.path === './ds/ds.css')!.rules.flatMap((r) => r.selectors);
    expect(selectors).toContain('.vf-dropfile > svg');
    expect(selectors.filter((s) => /\.vf-dropfile\s+svg/.test(s))).toEqual([]);
  });
});
