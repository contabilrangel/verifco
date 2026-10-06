/*
 * Registro de "parsers" de páginas do eCAC — o ponto de extensão da captura.
 *
 * O HTML do eCAC não é público nem estável. Por isso a extensão NÃO traz leitura pronta das
 * páginas: cada parser é registrado aqui, começa DESLIGADO e só roda quando o usuário habilita
 * a captura no popup e marca aquele parser. Um parser recebe o documento da página e devolve
 * registros no formato de POST /api/sync/ecac-records:
 *
 *   { kind, cpf, year?, externalId?, data: {...}, file?: { filename, mimeType, base64 } }
 *
 * `kind`: declaration | income_statement | cnd | simplified_status | mailbox_message |
 *         procuration | fiscal_situation | darf | other (campos de `data` no README).
 *
 * Este arquivo também é carregado pelo popup, para listar os parsers disponíveis.
 */
(function () {
  const KINDS = ['declaration', 'income_statement', 'cnd', 'simplified_status', 'mailbox_message', 'procuration', 'fiscal_situation', 'darf', 'other'];
  const parsers = [];

  const matchesUrl = (parser, url) => parser.matches.some((m) => (m instanceof RegExp ? m.test(url) : url.startsWith(String(m))));

  /** Utilitários genéricos de leitura do DOM, sem supor a estrutura de nenhuma página. */
  const helpers = {
    text: (root, selector) => (root.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    /** Valor ao lado de um rótulo (ex.: "Situação:"), procurando em dt/dd, th/td e label. */
    valueByLabel(root, label) {
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[:\s]+/g, ' ').trim();
      const target = norm(label);
      for (const el of root.querySelectorAll('dt, th, label, strong, b, span')) {
        if (norm(el.textContent ?? '') !== target) continue;
        const next = el.tagName === 'DT' ? el.nextElementSibling : el.tagName === 'TH' ? el.parentElement?.querySelector('td') : el.nextElementSibling;
        const v = (next?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (v) return v;
      }
      return null;
    },
    /** "1.234,56" → 123456 (centavos) ou null. */
    moneyToCents(v) {
      const s = String(v ?? '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
      const n = Number(s);
      return s && Number.isFinite(n) ? Math.round(n * 100) : null;
    },
    /** "31/12/2026" → "2026-12-31" ou null. */
    dateToIso(v) {
      const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(v ?? ''));
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    },
  };

  function validRecord(r) {
    return r && typeof r === 'object' && KINDS.includes(r.kind) && /^\d{11}(\d{3})?$/.test(String(r.cpf ?? '').replace(/\D+/g, '')) && (r.data === undefined || typeof r.data === 'object');
  }

  globalThis.VerifcoCapture = {
    KINDS,
    helpers,
    /**
     * Registra um parser.
     * @param {{ id: string, description: string, matches: (RegExp|string)[],
     *           parse: (doc: Document, ctx: { url: string, cpf: string|null, helpers: object }) => object[] | Promise<object[]> }} def
     */
    register(def) {
      if (!def || typeof def.id !== 'string' || typeof def.parse !== 'function' || !Array.isArray(def.matches)) {
        console.warn('[Verifco] Parser inválido ignorado:', def?.id);
        return;
      }
      if (parsers.some((p) => p.id === def.id)) return;
      parsers.push({ description: '', ...def });
    },
    list() {
      return parsers.map((p) => ({ id: p.id, description: p.description }));
    },
    /** Roda os parsers habilitados que casam com a URL e devolve os registros válidos. */
    async run({ url, doc, cpf, enabledIds }) {
      const enabled = new Set(enabledIds ?? []);
      const records = [];
      const ran = [];
      const errors = [];
      for (const p of parsers) {
        if (!enabled.has(p.id)) continue; // todo parser começa desligado
        if (!matchesUrl(p, url)) continue;
        ran.push(p.id);
        try {
          const out = await p.parse(doc, { url, cpf, helpers });
          for (const r of Array.isArray(out) ? out : []) {
            const rec = { ...r, cpf: String(r.cpf ?? cpf ?? '').replace(/\D+/g, '') };
            if (validRecord(rec)) records.push(rec);
            else errors.push(`${p.id}: registro fora do formato descartado`);
          }
        } catch (err) {
          errors.push(`${p.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { records, ran, errors };
    },
  };
})();
