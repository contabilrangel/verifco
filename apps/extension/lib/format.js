/*
 * Funções puras da extensão Verifco (sem `chrome.*` nem DOM): CPF, datas, textos, nomes de
 * arquivo, cliente em uso e histórico. Script clássico: define `globalThis.VerifcoFormat`.
 * Testadas com `node --test` (test/format.test.mjs).
 */
(function () {
  const onlyDigits = (v) => String(v ?? '').replace(/\D+/g, '');

  /** "52998224725" → "529.982.247-25"; CNPJ com 14 dígitos também. Outro tamanho volta como veio. */
  const formatCpf = (v) => {
    const d = onlyDigits(v);
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return String(v ?? '');
  };

  /** CPF para o histórico local: "***.982.247-**" (não guardamos o número inteiro). */
  const maskCpf = (v) => {
    const d = onlyDigits(v);
    if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
    if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/****-**`;
    return d ? '***' : '';
  };

  const checkDigit = (digits, weights) => {
    const sum = weights.reduce((acc, w, i) => acc + Number(digits[i]) * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  function isValidCpf(v) {
    const d = onlyDigits(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const d1 = checkDigit(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = checkDigit(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === Number(d[9]) && d2 === Number(d[10]);
  }

  /** CNPJ numérico (a API é quem decide sobre outros formatos). */
  function isValidCnpj(v) {
    const d = onlyDigits(v);
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const d1 = checkDigit(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = checkDigit(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === Number(d[12]) && d2 === Number(d[13]);
  }

  const isValidCpfCnpj = (v) => isValidCpf(v) || isValidCnpj(v);

  /** Origem (protocolo + host + porta) de uma URL http(s), ou null. */
  const originOf = (url) => {
    try {
      const u = new URL(String(url).trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
      return null;
    }
  };

  /** Ano-exercício corrente: a declaração entregue em 2026 é do exercício 2026. */
  const currentExerciseYear = (now = new Date()) => now.getFullYear();

  /** Ano com 4 dígitos entre 2000 e 2100, ou null. */
  const parseYear = (v) => {
    const s = String(v ?? '').trim();
    if (!/^\d{4}$/.test(s)) return null;
    const n = Number(s);
    return n >= 2000 && n <= 2100 ? n : null;
  };

  const isIsoDate = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  };

  /** Minúsculas e sem acentos, para comparar nomes. */
  const foldText = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();

  /** Texto de página: espaços repetidos viram um, no máximo uma linha em branco seguida. */
  const cleanText = (s) =>
    String(s ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  /** Corta no limite (o "…" conta no limite). */
  function truncateText(text, max) {
    const s = String(text ?? '');
    if (s.length <= max) return { text: s, truncated: false };
    return { text: `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`, truncated: true };
  }

  /** Linha de GET /api/sync/customers (formato novo ou o antigo, com `procurator`). */
  function normalizeCustomer(row) {
    const cpf = onlyDigits(row?.cpf);
    if (!cpf) return null;
    return {
      cpf,
      name: String(row?.name ?? '').trim(),
      procurationStatus: row?.procurationStatus ?? null,
      hasProcurator: typeof row?.hasProcurator === 'boolean' ? row.hasProcurator : Boolean(row?.procurator),
    };
  }

  /**
   * Filtro local por nome (sem acentos) ou dígitos do CPF. Só é usado quando o servidor é antigo
   * e devolve a lista inteira, ignorando `q` e `limit`.
   */
  function filterCustomers(list, q, limit = 20) {
    const text = foldText(q);
    const digits = onlyDigits(q);
    const out = [];
    for (const c of list ?? []) {
      if (!c) continue;
      const byName = text && foldText(c.name).includes(text);
      const byCpf = digits && c.cpf.includes(digits);
      if (!text || byName || byCpf) out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Cliente em uso: o escolhido no popup ou o CPF do último "Acessar" do Verifco (válido por
   * `ttlMs`). Vale o mais recente dos dois; `null` quando não há nenhum.
   */
  function resolveClient(selected, pending, now, ttlMs) {
    const p = pending && onlyDigits(pending.cpf) && now - Number(pending.at ?? 0) < ttlMs ? pending : null;
    const s = selected && onlyDigits(selected.cpf) ? selected : null;
    if (p && (!s || (onlyDigits(p.cpf) !== onlyDigits(s.cpf) && Number(p.at ?? 0) > Number(s.at ?? 0)))) {
      return { cpf: onlyDigits(p.cpf), name: null, source: 'context' };
    }
    if (s) return { cpf: onlyDigits(s.cpf), name: s.name || null, source: 'selected' };
    return null;
  }

  /** Histórico de envios: o mais novo primeiro, no máximo `max` itens. */
  function appendLog(list, entry, max = 30) {
    const item = {
      at: Number(entry?.at) || Date.now(),
      name: String(entry?.name ?? '').slice(0, 120),
      cpf: maskCpf(entry?.cpf),
      what: String(entry?.what ?? '').slice(0, 160),
      ok: Boolean(entry?.ok),
      detail: String(entry?.detail ?? '').slice(0, 300),
    };
    return [item, ...(Array.isArray(list) ? list : [])].slice(0, max);
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** "hoje 14:05" ou "09/11 14:05" (hora local). */
  function formatWhen(ts, now = new Date()) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? `hoje ${time}` : `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${time}`;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
    return `${(v / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  }

  /** Tira caminho e caracteres de controle; no máximo 200 caracteres (limite da API). */
  function sanitizeFileName(name) {
    const base = String(name ?? '')
      .split(/[\\/]/)
      .pop()
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
      .trim();
    if (base.length <= 200) return base;
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? '';
    return base.slice(0, 200 - ext.length) + ext;
  }

  /** Nome do arquivo no cabeçalho Content-Disposition (`filename*=` tem preferência), ou null. */
  function fileNameFromDisposition(header) {
    const h = String(header ?? '');
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
    if (star) {
      try {
        const name = sanitizeFileName(decodeURIComponent(star[1].trim()));
        if (name) return name;
      } catch {
        /* segue para o filename simples */
      }
    }
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(h);
    const name = sanitizeFileName(plain?.[1] ?? plain?.[2] ?? '');
    return name || null;
  }

  /** Último trecho do caminho da URL, ou null. */
  function fileNameFromUrl(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
      let name = last;
      try {
        name = decodeURIComponent(last);
      } catch {
        /* fica como veio */
      }
      return sanitizeFileName(name) || null;
    } catch {
      return null;
    }
  }

  const MIME_EXTENSIONS = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/xml': 'xml',
    'application/xml': 'xml',
    'application/zip': 'zip',
  };
  const extensionForMime = (mime) => MIME_EXTENSIONS[String(mime ?? '').split(';')[0].trim().toLowerCase()] ?? null;

  /** Nome para um arquivo baixado: cabeçalho, senão URL; completa a extensão pelo tipo. */
  function pickFileName({ disposition, url, mime }) {
    const ext = extensionForMime(mime);
    let name = fileNameFromDisposition(disposition) ?? fileNameFromUrl(url) ?? 'arquivo';
    if (ext && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name = `${name}.${ext}`;
    return sanitizeFileName(name);
  }

  /**
   * URL a baixar num clique do menu de contexto: o link, senão a imagem/mídia, senão (quando
   * `allowPage`) a própria página. Só http(s); links `javascript:` e `blob:` não servem.
   */
  function pickMenuUrl(info, allowPage = false) {
    const candidates = [info?.linkUrl, info?.srcUrl, allowPage ? info?.pageUrl : null];
    for (const c of candidates) {
      if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
    }
    return null;
  }

  globalThis.VerifcoFormat = {
    onlyDigits,
    formatCpf,
    maskCpf,
    isValidCpf,
    isValidCnpj,
    isValidCpfCnpj,
    originOf,
    currentExerciseYear,
    parseYear,
    isIsoDate,
    foldText,
    cleanText,
    truncateText,
    normalizeCustomer,
    filterCustomers,
    resolveClient,
    appendLog,
    formatWhen,
    formatBytes,
    sanitizeFileName,
    fileNameFromDisposition,
    fileNameFromUrl,
    extensionForMime,
    pickFileName,
    pickMenuUrl,
  };
})();
