/*
 * Content script das páginas do eCAC.
 *
 * 1. Se a aba foi aberta pelo botão "Acessar" do Verifco, mostra um aviso discreto com o
 *    serviço pedido e o CPF do cliente (com botão para copiar), para o procurador trocar o
 *    perfil de acesso. Nada é preenchido automaticamente.
 * 2. Se a captura estiver habilitada no popup, roda os parsers marcados (content/parsers.js)
 *    e envia os registros ao Verifco pelo service worker. Reexecuta quando a página muda de
 *    rota (páginas de aplicação única).
 */
(async function () {
  if (globalThis.__verifcoEcacLoaded) return;
  globalThis.__verifcoEcacLoaded = true;
  const { formatCpf } = globalThis.VerifcoConfig;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res));
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });

  const state = await send({ kind: 'get-context' });
  if (!state?.ok) return;
  const banner = state.context || state.captureEnabled ? createBanner(state) : null;

  if (state.captureEnabled && state.configured) {
    let timer = null;
    let lastUrl = '';
    const capture = async () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      const { records, ran, errors } = await globalThis.VerifcoCapture.run({ url: location.href, doc: document, cpf: state.context?.cpf ?? null, enabledIds: state.enabledParsers });
      if (errors.length) console.warn('[Verifco] Captura:', errors);
      if (!ran.length) return;
      if (!records.length) {
        banner?.status('Nenhum dado reconhecido nesta página.');
        return;
      }
      const res = await send({ kind: 'send-records', records });
      if (!res?.ok) banner?.status(`Falha ao enviar: ${res?.error ?? 'erro desconhecido'}`, true);
      else banner?.status(`${res.result?.ok ?? 0} registro(s) enviado(s) ao Verifco${res.result?.failed ? `, ${res.result.failed} recusado(s)` : ''}.`);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void capture(), 1200);
    };
    window.addEventListener('hashchange', schedule);
    window.addEventListener('popstate', schedule);
    schedule();
  }

  /** Aviso flutuante (Shadow DOM, para não herdar nem quebrar o estilo da página). */
  function createBanner(st) {
    const host = document.createElement('div');
    host.setAttribute('data-verifco', 'banner');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const ctx = st.context;
    root.innerHTML = `
      <style>
        .box{font:500 13px/18px system-ui,-apple-system,"Segoe UI",sans-serif;color:#212429;background:#fff;border:1px solid #e1e4e8;border-left:4px solid #3468e6;
             border-radius:10px;box-shadow:0 8px 18px #00223329;padding:12px 14px;max-width:340px;display:flex;flex-direction:column;gap:6px}
        .top{display:flex;justify-content:space-between;align-items:center;gap:8px}
        b{color:#0f2457} .muted{color:#636e7c;font-size:12px} .err{color:#be3450}
        button{font:inherit;border:1px solid #3468e6;color:#3468e6;background:#fff;border-radius:999px;padding:2px 10px;cursor:pointer}
        button.x{border:0;padding:0 4px;font-size:16px;color:#636e7c}
        .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      </style>
      <div class="box" role="status">
        <div class="top"><b>Verifco</b><button class="x" title="Fechar" aria-label="Fechar">×</button></div>
        ${ctx ? `<div>Serviço pedido: <b class="svc"></b></div>` : ''}
        ${ctx && ctx.cpf ? `<div class="row">Cliente: <span class="cpf"></span><button class="copy">Copiar CPF</button></div>
        <div class="muted">Se você atua como procurador, use “Alterar perfil de acesso” no eCAC e informe este CPF.</div>` : ''}
        <div class="muted status">${st.captureEnabled ? (st.configured ? 'Captura habilitada.' : 'Captura habilitada, mas a extensão não está conectada ao Verifco.') : ''}</div>
      </div>`;
    if (ctx) root.querySelector('.svc').textContent = ctx.serviceLabel ?? ctx.service;
    if (ctx?.cpf) {
      root.querySelector('.cpf').textContent = formatCpf(ctx.cpf);
      root.querySelector('.copy').addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(ctx.cpf);
          e.target.textContent = 'Copiado';
        } catch {
          e.target.textContent = ctx.cpf;
        }
      });
    }
    root.querySelector('.x').addEventListener('click', () => {
      host.remove();
      void send({ kind: 'clear-context' });
    });
    document.documentElement.appendChild(host);
    return {
      status(text, isError = false) {
        const el = root.querySelector('.status');
        el.textContent = text;
        el.className = `muted status${isError ? ' err' : ''}`;
      },
    };
  }
})();
