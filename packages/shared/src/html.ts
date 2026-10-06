/**
 * Sanitização do HTML dos templates de e-mail (lista de permissões).
 *
 * Mantém a formatação de um editor rico (títulos, listas, links, imagens, cores, tabelas)
 * e remove o que pode executar código: `<script>`, `<iframe>`, atributos `on*=`,
 * URLs `javascript:`/`vbscript:`/`data:` (exceto imagens) e expressões em `style`.
 * As variáveis `{{VAR}}` são preservadas, inclusive dentro de `href` e `src`.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small',
  'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** Elementos removidos junto com todo o conteúdo. */
const DROP_WITH_CONTENT = ['script', 'style', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'noscript', 'template', 'svg', 'math', 'xml', 'title', 'head', 'textarea', 'select', 'button'];

const ALLOWED_ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'colspan', 'dir', 'face', 'height', 'href', 'lang',
  'rel', 'rowspan', 'size', 'src', 'start', 'style', 'target', 'title', 'type', 'valign', 'width',
]);
const URL_ATTRS = new Set(['href', 'src']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

/** URL segura para href/src: http(s), mailto, tel, âncora, caminho relativo ou variável do template. */
export function isSafeUrl(value: string, attr: 'href' | 'src' = 'href'): boolean {
  // remove espaços e caracteres de controle usados para disfarçar o esquema (java\nscript:)
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
  if (!v) return true;
  if (/^\{\{\s*[a-z0-9_]+\s*\}\}/.test(v)) return true;
  if (attr === 'src' && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(v)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!scheme) return true; // relativo, âncora ou caminho
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1]);
}

const escapeAttr = (s: string) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanStyle(style: string): string | null {
  const v = decodeEntities(style).toLowerCase().replace(/\s+/g, '');
  if (/expression\(|javascript:|vbscript:|behavior:|-moz-binding|@import|url\(/.test(v)) return null;
  return style;
}

function cleanAttributes(tag: string, raw: string): string {
  const out: string[] = [];
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) continue;
    if (URL_ATTRS.has(name) && !isSafeUrl(value, name as 'href' | 'src')) continue;
    if (name === 'style') {
      const s = cleanStyle(value);
      if (s === null) continue;
    }
    if (name === 'target' && !['_blank', '_self'].includes(value)) continue;
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  if (tag === 'a' && out.some((a) => a.startsWith('target="_blank"')) && !out.some((a) => a.startsWith('rel='))) out.push('rel="noopener noreferrer"');
  return out.length ? ' ' + out.join(' ') : '';
}

export function sanitizeHtml(input: string): string {
  // eslint-disable-next-line no-control-regex
  let html = String(input ?? '').replace(/\u0000/g, '');
  // comentários, CDATA e instruções de processamento
  html = html.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/gi, '').replace(/<[?!][^>]*>/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // tag aberta sem fechamento: descarta até o fim
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, 'gi'), '');
  }
  // as tags aceitas viram marcadores; o que sobrar de "<" e ">" é texto e é escapado
  const kept: string[] = [];
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g, (full, rawTag: string, rest: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    let out: string;
    if (full.startsWith('</')) {
      if (VOID_TAGS.has(tag)) return '';
      out = `</${tag}>`;
    } else {
      const selfClosing = /\/\s*$/.test(rest);
      const attrs = cleanAttributes(tag, rest.replace(/\/\s*$/, ''));
      out = VOID_TAGS.has(tag) || selfClosing ? `<${tag}${attrs} />` : `<${tag}${attrs}>`;
    }
    kept.push(out);
    return `\u0000${kept.length - 1}\u0000`;
  });
  html = html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // eslint-disable-next-line no-control-regex
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]);
}
