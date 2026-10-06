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

/** Caractere de uma referência numérica; código fora do Unicode vira U+FFFD (como no navegador), sem lançar erro. */
const fromCode = (n: number) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd');

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => fromCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => fromCode(Number(d)))
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

// ---------------------------------------------------------------------------
// Escape e conversão para texto simples
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa um valor para entrar no HTML (texto ou atributo entre aspas). */
export const escapeHtml = (s: string): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Entidades nomeadas usuais em textos em português (as numéricas são decodificadas todas). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: '\u00a0', shy: '\u00ad',
  colon: ':', tab: '\t', newline: '\n',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', ordm: 'º', ordf: 'ª', sect: '§', para: '¶',
  euro: '€', cent: '¢', pound: '£', yen: '¥', times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿',
  Aacute: 'Á', aacute: 'á', Agrave: 'À', agrave: 'à', Acirc: 'Â', acirc: 'â', Atilde: 'Ã', atilde: 'ã', Auml: 'Ä', auml: 'ä',
  Eacute: 'É', eacute: 'é', Egrave: 'È', egrave: 'è', Ecirc: 'Ê', ecirc: 'ê', Euml: 'Ë', euml: 'ë',
  Iacute: 'Í', iacute: 'í', Igrave: 'Ì', igrave: 'ì', Icirc: 'Î', icirc: 'î', Iuml: 'Ï', iuml: 'ï',
  Oacute: 'Ó', oacute: 'ó', Ograve: 'Ò', ograve: 'ò', Ocirc: 'Ô', ocirc: 'ô', Otilde: 'Õ', otilde: 'õ', Ouml: 'Ö', ouml: 'ö',
  Uacute: 'Ú', uacute: 'ú', Ugrave: 'Ù', ugrave: 'ù', Ucirc: 'Û', ucirc: 'û', Uuml: 'Ü', uuml: 'ü',
  Ccedil: 'Ç', ccedil: 'ç', Ntilde: 'Ñ', ntilde: 'ñ',
};

/**
 * Decodifica as entidades numa só passada, como o navegador: `&amp;lt;` vira `&lt;`, não `<`.
 * Referências numéricas valem com ou sem ponto e vírgula; nomeadas desconhecidas ficam como estão.
 */
export function decodeHtmlEntities(s: string): string {
  return String(s ?? '').replace(/&(?:#x([0-9a-f]+);?|#(\d+);?|([a-z][a-z0-9]*);)/gi, (full, hex?: string, dec?: string, name?: string) => {
    if (hex) return fromCode(parseInt(hex, 16));
    if (dec) return fromCode(Number(dec));
    return (name && NAMED_ENTITIES[name]) ?? full;
  });
}

export interface HtmlToTextOptions {
  /** Links como "texto (endereço)", para texto corrido; por padrão, "texto: endereço". */
  linksInParens?: boolean;
  /** Linha em branco depois de cada parágrafo, título, item e bloco (texto de PDF); por padrão, uma quebra de linha. */
  blankLines?: boolean;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');

/**
 * HTML dos templates em texto simples: é o texto do WhatsApp, da prévia da mala direta e dos PDFs
 * do financeiro. Quebra a linha em `<br>`, `<hr>` e no fim de parágrafos, `<div>`, títulos, itens
 * de lista e linhas de tabela (com ou sem atributos); põe "• " antes de cada item; mostra o
 * endereço dos links; e decodifica todas as entidades (`&#39;`, `&quot;`, `&nbsp;`...).
 */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  const block = opts.blankLines ? '\n\n' : '\n';
  const link = (href: string, inner: string) => {
    const url = decodeHtmlEntities(href).trim();
    const label = decodeHtmlEntities(stripTags(inner)).trim();
    if (!url) return inner;
    // sem texto ou com o próprio endereço como texto: o endereço aparece uma vez só
    if (!label || label === url) return href;
    return opts.linksInParens ? `${inner} (${href})` : `${inner}: ${href}`;
  };
  const text = String(html ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, block)
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, block)
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(
      /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => link(dq ?? sq ?? bare ?? '', inner),
    );
  return decodeHtmlEntities(stripTags(text))
    .replace(/\u00a0/g, ' ')
    .replace(/\u00ad/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
