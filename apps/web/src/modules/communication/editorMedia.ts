/**
 * Imagens e vídeos no editor de templates de e-mail.
 *
 * Clientes de e-mail não reproduzem vídeo: o vídeo entra como link (com a miniatura,
 * quando é do YouTube). Imagens entram por endereço público (https) ou embutidas no
 * template (data:image), o que o sanitizador do servidor aceita; no envio SMTP o servidor
 * converte cada data:image em anexo inline referenciado por `cid:` (Gmail e Outlook não exibem data: URI).
 */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Variável de template ({{LINK}}), aceita no lugar de um endereço. */
const isTemplateVar = (s: string) => /^\{\{[A-Z0-9_]+\}\}$/.test(s);

/** Endereço absoluto http(s) sem espaços (ou variável de template). */
export const isPublicUrl = (url: string) => isTemplateVar(url.trim()) || /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(url.trim());

/** Link aceito no editor: http(s), mailto: ou variável. */
export const isLinkUrl = (url: string) => isPublicUrl(url) || /^mailto:[^\s]+$/i.test(url.trim());

/** Id do vídeo do YouTube (youtube.com/watch?v=, youtu.be/, /shorts/, /embed/), ou null. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : null;
    }
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** HTML do vídeo para o e-mail: miniatura clicável (YouTube) ou botão "Assistir ao vídeo". */
export function videoHtml(url: string, title: string): string {
  const href = escapeHtml(url.trim());
  const label = escapeHtml(title.trim() || 'Assistir ao vídeo');
  const id = youtubeId(url);
  if (id) {
    return (
      `<p><a href="${href}" target="_blank"><img src="https://img.youtube.com/vi/${id}/hqdefault.jpg" alt="▶ ${label}" width="480" style="max-width: 100%; height: auto; border-radius: 8px;" /></a><br />` +
      `<a href="${href}" target="_blank">▶ ${label}</a></p>`
    );
  }
  return `<p><a href="${href}" target="_blank" style="display: inline-block; padding: 10px 18px; border-radius: 8px; background-color: #3468e6; color: #ffffff; text-decoration: none; font-weight: bold;">▶ ${label}</a></p>`;
}

/** HTML da imagem (endereço público ou data:image embutido). */
export const imageHtml = (src: string, alt: string) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="max-width: 100%; height: auto;" />`;

/** Tipos de imagem que o servidor aceita embutidos no e-mail. */
export const EMBED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Tamanho máximo da imagem embutida (caracteres do data URL; o corpo do template aceita 200 mil). */
export const MAX_EMBED_CHARS = 120_000;
/** Largura máxima da imagem embutida, em px (largura útil de um e-mail). */
export const EMBED_MAX_WIDTH = 640;

/** Dimensões finais mantendo a proporção, sem ampliar. */
export function fitWidth(width: number, height: number, max = EMBED_MAX_WIDTH): { width: number; height: number } {
  if (width <= max) return { width, height };
  return { width: max, height: Math.round((height * max) / width) };
}

/**
 * Lê a imagem do computador, reduz para no máximo 640 px de largura e devolve o data URL
 * (PNG se couber, senão JPEG com qualidade decrescente). Lança Error com mensagem para o usuário.
 */
export async function imageFileToDataUrl(file: File): Promise<string> {
  if (!EMBED_TYPES.includes(file.type)) throw new Error('Use uma imagem PNG, JPG, WEBP ou GIF.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      el.src = url;
    });
    const { width, height } = fitWidth(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Seu navegador não conseguiu processar a imagem.');
    g.drawImage(img, 0, 0, width, height);
    const png = canvas.toDataURL('image/png');
    if (png.length <= MAX_EMBED_CHARS) return png;
    // JPEG não tem transparência: fundo branco
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, width, height);
    for (const q of [0.85, 0.7, 0.55]) {
      const jpg = canvas.toDataURL('image/jpeg', q);
      if (jpg.length <= MAX_EMBED_CHARS) return jpg;
    }
    throw new Error('A imagem é grande demais para ir embutida no e-mail. Reduza o arquivo ou use o endereço público da imagem.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
