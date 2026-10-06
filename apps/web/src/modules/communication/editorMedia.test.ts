import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '@verifco/shared';
import { EMBED_MAX_WIDTH, fitWidth, imageHtml, isLinkUrl, isPublicUrl, videoHtml, youtubeId } from './editorMedia';

describe('vídeo no template de e-mail', () => {
  it('reconhece os formatos de endereço do YouTube', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://vimeo.com/123456')).toBeNull();
    expect(youtubeId('https://youtube.com.golpe.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeId('não é endereço')).toBeNull();
  });

  it('YouTube vira miniatura clicável que passa pelo sanitizador do servidor', () => {
    const html = videoHtml('https://youtu.be/dQw4w9WgXcQ', 'Como enviar seus documentos');
    const clean = sanitizeHtml(html);
    expect(clean).toContain('src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
    expect(clean).toContain('href="https://youtu.be/dQw4w9WgXcQ"');
    expect(clean).toContain('▶ Como enviar seus documentos');
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('outros vídeos viram um botão "Assistir ao vídeo"', () => {
    const clean = sanitizeHtml(videoHtml('https://vimeo.com/123456', ''));
    expect(clean).toContain('href="https://vimeo.com/123456"');
    expect(clean).toContain('▶ Assistir ao vídeo');
    expect(clean).toContain('background-color: #3468e6');
  });

  it('escapa o título e o endereço', () => {
    const html = videoHtml('https://vimeo.com/1?a="><script>alert(1)</script>', '"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    // o título fica como texto (&lt;...&gt;), nunca como tag ou atributo
    const doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    expect(doc.querySelectorAll('script, img').length).toBe(0);
    expect([...doc.querySelectorAll('*')].some((el) => el.hasAttribute('onerror'))).toBe(false);
    expect(doc.querySelector('a')?.textContent).toBe('▶ "><img src=x onerror=alert(1)>');
  });
});

describe('imagem no template de e-mail', () => {
  it('aceita endereço público (https) ou variável, e recusa o resto', () => {
    expect(isPublicUrl('https://escritorio.com.br/banner.png')).toBe(true);
    expect(isPublicUrl('http://escritorio.com.br/banner.png')).toBe(true);
    expect(isPublicUrl('{{LINK}}')).toBe(true);
    expect(isPublicUrl('https://')).toBe(false);
    expect(isPublicUrl('/api/files/123')).toBe(false);
    expect(isPublicUrl('javascript:alert(1)')).toBe(false);
    expect(isLinkUrl('mailto:contato@escritorio.com.br')).toBe(true);
    expect(isPublicUrl('mailto:contato@escritorio.com.br')).toBe(false);
  });

  it('imagem embutida (data:image) sobrevive ao sanitizador do servidor', () => {
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const clean = sanitizeHtml(imageHtml(data, 'Logo do escritório'));
    expect(clean).toContain(`src="${data}"`);
    expect(clean).toContain('alt="Logo do escritório"');
  });

  it('reduz para a largura de um e-mail mantendo a proporção, sem ampliar', () => {
    expect(fitWidth(1920, 1080)).toEqual({ width: EMBED_MAX_WIDTH, height: 360 });
    expect(fitWidth(300, 100)).toEqual({ width: 300, height: 100 });
  });
});
