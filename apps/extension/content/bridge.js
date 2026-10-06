/*
 * Ponte entre a página do Verifco e a extensão.
 *
 * A página envia window.postMessage({ type, requestId, ... }) para a própria janela:
 *   - VERIFCO_PING                         → responde se a extensão está ativa;
 *   - VERIFCO_OPEN_ECAC { service, cpf }   → abre o serviço do eCAC numa nova aba.
 * A resposta volta como { type: 'VERIFCO_EXTENSION_ACK', requestId, ok, version, error? }.
 * Só mensagens da mesma janela e da mesma origem são aceitas.
 */
(function () {
  if (globalThis.__verifcoBridgeLoaded) return; // registro fixo + dinâmico na mesma página
  globalThis.__verifcoBridgeLoaded = true;
  const VERSION = chrome.runtime.getManifest().version;

  const reply = (requestId, payload) => {
    window.postMessage({ ok: false, ...payload, type: 'VERIFCO_EXTENSION_ACK', requestId, version: VERSION }, location.origin);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.requestId !== 'string') return;
    if (data.type === 'VERIFCO_PING') {
      reply(data.requestId, { ok: true });
      return;
    }
    if (data.type === 'VERIFCO_OPEN_ECAC') {
      chrome.runtime.sendMessage({ kind: 'open-ecac', service: String(data.service ?? ''), cpf: String(data.cpf ?? '') }, (res) => {
        if (chrome.runtime.lastError) reply(data.requestId, { ok: false, error: chrome.runtime.lastError.message });
        else reply(data.requestId, res ?? { ok: false, error: 'Sem resposta da extensão.' });
      });
    }
  });
})();
