/*
 * Content script das páginas da Receita (eCAC e serviços).
 *
 * Se a aba foi aberta pelo botão "Acessar" do Verifco (nos últimos 30 minutos), mostra um aviso
 * discreto com o serviço pedido e o CPF do cliente, com dois botões:
 *   - "Copiar CPF", para o procurador trocar o perfil de acesso;
 *   - "Registrar página", que envia ao Verifco o título, o endereço e o texto visível (ou o
 *     selecionado) desta página, para aquele cliente. Só envia quando o usuário clica.
 * Nada é preenchido, clicado nem lido automaticamente.
 *
 * O aviso acompanha a navegação dentro da mesma página (aplicações de página única): a cada
 * mudança de rota o contexto é conferido de novo e o aviso é recolocado se a página o remover.
 */
(async function () {
  if (globalThis.__verifcoEcacLoaded) return;
  globalThis.__verifcoEcacLoaded = true;
  if (window.top !== window) return; // só no quadro principal
  const { formatCpf } = globalThis.VerifcoFormat;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res));
      } catch (err) {
        resolve({ ok: false, error: String(err) }); // extensão recarregada com a página aberta
      }
    });

  let banner = null; // { host, key, setStatus }
  let dismissedKey = null; // aviso fechado pelo usuário: não volta para o mesmo contexto

  const keyOf = (state) => (state.context ? `${state.context.service}|${state.context.cpf}|${state.context.at}|${state.configured}` : '');

  async function refresh() {
    const state = await send({ kind: 'get-context' });
    if (!state?.ok || !state.context) {
      banner?.host.remove();
      banner = null;
      return;
    }
    const key = keyOf(state);
    if (key === dismissedKey) return;
    if (banner && banner.key === key) {
      if (!banner.host.isConnected) document.documentElement.appendChild(banner.host);
      return;
    }
    banner?.host.remove();
    banner = createBanner(state, key);
  }

  /** Aviso flutuante (Shadow DOM, para não herdar nem quebrar o estilo da página). */
  function createBanner(st, key) {
    const ctx = st.context;
    const host = document.createElement('div');
    host.setAttribute('data-verifco', 'banner');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .box{font:500 13px/18px system-ui,-apple-system,"Segoe UI",sans-serif;color:#212429;background:#fff;border:1px solid #e1e4e8;border-left:4px solid #3468e6;
             border-radius:10px;box-shadow:0 8px 18px #00223329;padding:12px 14px;max-width:340px;display:flex;flex-direction:column;gap:6px}
        .top{display:flex;justify-content:space-between;align-items:center;gap:8px}
        b{color:#0f2457} .muted{color:#636e7c;font-size:12px} .err{color:#be3450} .ok{color:#25702e}
        button{font:inherit;border:1px solid #3468e6;color:#3468e6;background:#fff;border-radius:999px;padding:2px 10px;cursor:pointer}
        button:disabled{opacity:.5;cursor:default}
        button.x{border:0;padding:0 4px;font-size:16px;color:#636e7c}
        .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .status:empty{display:none}
      </style>
      <div class="box" role="status">
        <div class="top"><b>Verifco</b><button class="x" title="Fechar" aria-label="Fechar">×</button></div>
        <div>Serviço pedido: <b class="svc"></b></div>
        <div class="client" hidden>
          <div class="row">Cliente: <span class="cpf"></span><button class="copy">Copiar CPF</button></div>
          <div class="muted">Se você atua como procurador, use “Alterar perfil de acesso” no eCAC e informe este CPF.</div>
          <div class="row"><button class="reg" title="Envia ao Verifco o título, o endereço e o texto visível (ou selecionado) desta página">Registrar página</button></div>
        </div>
        <div class="muted status"></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const setStatus = (text, kind = '') => {
      const el = $('.status');
      el.textContent = text;
      el.className = `muted status ${kind}`.trim();
    };
    $('.svc').textContent = ctx.serviceLabel ?? ctx.service;
    if (ctx.cpf) {
      $('.client').hidden = false;
      $('.cpf').textContent = formatCpf(ctx.cpf);
      $('.copy').addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(ctx.cpf);
          e.target.textContent = 'Copiado';
        } catch {
          e.target.textContent = ctx.cpf;
        }
      });
      const reg = $('.reg');
      if (!st.configured) {
        reg.disabled = true;
        setStatus('Para registrar páginas, conecte a extensão ao Verifco (ícone da extensão › Configuração).');
      }
      reg.addEventListener('click', async () => {
        reg.disabled = true;
        setStatus('Enviando ao Verifco…');
        // o aviso sai da frente para não aparecer na imagem da tela
        host.style.visibility = 'hidden';
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const res = await send({ kind: 'register-page' });
        host.style.visibility = '';
        reg.disabled = false;
        if (res?.ok) setStatus(`Página registrada no Verifco${res.withScreenshot ? ', com a imagem da tela' : ' (só o texto)'}.`, 'ok');
        else setStatus(`Não foi registrada: ${res?.error ?? 'erro desconhecido'}`, 'err');
      });
    }
    $('.x').addEventListener('click', () => {
      dismissedKey = key;
      host.remove();
      banner = null;
      void send({ kind: 'clear-context' });
    });
    document.documentElement.appendChild(host);
    return { host, key, setStatus };
  }

  // --- navegação sem recarregar a página -------------------------------------------------
  let timer = null;
  const onNavigate = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 300);
  };
  window.addEventListener('hashchange', onNavigate);
  window.addEventListener('popstate', onNavigate);
  window.addEventListener('pageshow', (e) => e.persisted && onNavigate()); // voltou do cache do navegador
  // history.pushState/replaceState: um content script roda num mundo isolado e não enxerga as
  // chamadas da página, então trocar essas funções aqui não adiantaria. A Navigation API avisa
  // dessas mudanças (e das demais) sem mexer em nada da página.
  if (globalThis.navigation && typeof globalThis.navigation.addEventListener === 'function') {
    globalThis.navigation.addEventListener('currententrychange', onNavigate);
    globalThis.navigation.addEventListener('navigatesuccess', onNavigate);
  }
  // se a página trocar o conteúdo e levar o aviso junto, ele volta
  let reattached = 0; // limite, para não disputar com uma página que insista em remover
  new MutationObserver(() => {
    if (banner && !banner.host.isConnected && reattached < 20) {
      reattached += 1;
      document.documentElement.appendChild(banner.host);
    }
  }).observe(document.documentElement, { childList: true });

  await refresh();
})();
