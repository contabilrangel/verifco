/*
 * Os envios da extensão, iguais no popup, no aviso do eCAC e no menu de contexto: cada um chama a
 * API, anota o resultado em "Últimos envios" (e no selo do ícone) e devolve
 * `{ ok: true, message, ... }` ou `{ ok: false, error }` com o texto pronto para mostrar.
 * Script clássico: define `globalThis.VerifcoActions`. Depende de lib/format.js, lib/statuses.js
 * e lib/capture.js; a API e o histórico são recebidos (test/actions.test.mjs usa versões de teste).
 */
(function () {
  const F = globalThis.VerifcoFormat;
  const S = globalThis.VerifcoStatuses;
  const Capture = globalThis.VerifcoCapture;

  const errorText = (err) => (err instanceof Error ? err.message : String(err));

  /**
   * @param {{ api: object, log: (entry: { cpf: string, name?: string|null, what: string, ok: boolean, detail?: string }) => Promise<unknown> }} deps
   */
  function createActions({ api, log }) {
    /** Roda o envio e anota o resultado; nunca lança. */
    async function run(client, what, send) {
      if (!client || !F.onlyDigits(client.cpf)) return { ok: false, error: 'Escolha o cliente antes de enviar.' };
      try {
        const out = await send();
        await log({ cpf: client.cpf, name: client.name, what, ok: true, detail: out.message ?? '' });
        return { ok: true, ...out };
      } catch (err) {
        const error = errorText(err);
        await log({ cpf: client.cpf, name: client.name, what, ok: false, detail: error });
        return { ok: false, error };
      }
    }

    return {
      /** Arquivo para os documentos do cliente ou, com `prefilled`, a declaração pré-preenchida. */
      sendFile({ client, file, filename, year, category, prefilled = false, origin, title, maxBytes }) {
        const name = F.sanitizeFileName(filename ?? file?.name) || 'arquivo';
        return run(client, `${prefilled ? 'Pré-preenchida' : 'Arquivo'}: ${name}`, async () => {
          if (!file || !file.size) throw new Error('O arquivo está vazio.');
          if (maxBytes && file.size > maxBytes) throw new Error(`O arquivo tem ${F.formatBytes(file.size)}; o limite é ${F.formatBytes(maxBytes)}.`);
          const y = year === undefined || year === null || year === '' ? null : F.parseYear(year);
          if (year !== undefined && year !== null && year !== '' && !y) throw new Error('Informe o exercício com 4 dígitos (ex.: 2026).');
          if (prefilled && !y) throw new Error('Informe o exercício da pré-preenchida.');
          const res = prefilled
            ? await api.sendPrefilled({ file, filename: name, cpf: client.cpf, year: y })
            : await api.sendDocument({ file, filename: name, cpf: client.cpf, year: y, category, origin, title });
          const who = res?.customer?.name || client.name || F.formatCpf(client.cpf);
          return {
            result: res,
            duplicate: Boolean(res?.duplicate),
            message: res?.duplicate ? `Já estava no Verifco (${who}${res?.year ? `, ${res.year}` : ''}).` : `Enviado para ${who}${res?.year ? `, exercício ${res.year}` : ''}.`,
          };
        });
      },

      /** Registro `other` com título, endereço, texto e (opcional) a imagem da tela. */
      registerPage({ client, page, screenshot = null }) {
        const title = String(page?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || page?.url || 'sem título';
        return run(client, `${page?.fromSelection ? 'Seleção' : 'Página'}: ${title}`, async () => {
          if (!String(page?.text ?? '').trim() && !screenshot) throw new Error('Não há texto nem imagem para registrar.');
          const result = await api.sendRecord(Capture.buildPageRecord({ cpf: client.cpf, ...page, screenshot }));
          return { result, withScreenshot: Boolean(screenshot), message: screenshot ? 'Registrado, com a imagem da tela.' : 'Registrado.' };
        });
      },

      /** Registro `declaration`: situação da declaração do exercício no eCAC. */
      sendDeclarationStatus({ client, year, status, receiptNumber }) {
        const label = S.DECLARATION_STATUS[status];
        return run(client, `${['Situação da declaração', F.parseYear(year)].filter(Boolean).join(' ')}: ${label ?? '?'}`, async () => {
          const y = F.parseYear(year);
          if (!y) throw new Error('Informe o exercício com 4 dígitos (ex.: 2026).');
          if (!label) throw new Error('Escolha a situação da declaração.');
          const data = { status };
          const receipt = String(receiptNumber ?? '').trim();
          if (receipt) data.receiptNumber = receipt.slice(0, 60);
          const result = await api.sendRecord({ kind: 'declaration', cpf: F.onlyDigits(client.cpf), year: y, data });
          return { result, message: `Situação registrada: ${label}.` };
        });
      },

      /** Registro `cnd`: situação da certidão, validade e código de controle. */
      sendCnd({ client, status, validUntil, code }) {
        const label = S.CND_STATUS[status];
        return run(client, `CND: ${label ?? '?'}`, async () => {
          if (!label) throw new Error('Escolha a situação da CND.');
          const data = { status };
          const until = String(validUntil ?? '').trim();
          if (until) {
            if (!F.isIsoDate(until)) throw new Error('Data de validade inválida.');
            data.validUntil = until;
          }
          const c = String(code ?? '').trim();
          if (c) data.code = c.slice(0, 60);
          const result = await api.sendRecord({ kind: 'cnd', cpf: F.onlyDigits(client.cpf), data });
          return { result, message: `CND registrada: ${label}.` };
        });
      },
    };
  }

  globalThis.VerifcoActions = { createActions };
})();
