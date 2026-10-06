import opentype from 'opentype.js';
import fs from 'node:fs';

const NAVY = '#0F2457', BLUE = '#3468E6', GREEN = '#14B88A', WHITE = '#FFFFFF';

// --- Símbolo: "V" de verificado montado com duas peças de tangram ---
// Peça longa (paralelogramo) e peça curta (trapézio), separadas por um vão diagonal.
function symbolPaths({ long = BLUE, short = GREEN } = {}) {
  const longBar = [[22, 54], [34, 54], [62, 10], [50, 10]];
  // linha do lado esquerdo da barra longa: 44x + 28y = 2480 ; vão g
  const g = 3.6, n = Math.hypot(44, 28), c = 2480 - g * n;
  const hit = (b) => { const x = (c - 28 * b) / 72; return [x, x + b]; }; // y = x + b
  const shortBar = [[3, 28], [16.5, 28], hit(11.5), hit(25)];
  const d = (pts) => 'M' + pts.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join('L') + 'Z';
  return `<path d="${d(shortBar)}" fill="${short}"/><path d="${d(longBar)}" fill="${long}"/>`;
}

const font = opentype.loadSync('dmsans-900.ttf');
function wordmark(color, dotColor, x0, baseline, size) {
  const text = 'verıfco';
  const p = font.getPath(text, x0, baseline, size, { letterSpacing: -0.035 });
  // posição do pingo: centro do glifo "ı"
  const adv = (s) => font.getAdvanceWidth(s, size, { letterSpacing: -0.035 });
  const before = adv('ver');
  const iW = font.getAdvanceWidth('ı', size);
  const g = font.charToGlyph('ı'); const bb = g.getBoundingBox(); const scale = size / font.unitsPerEm;
  const cx = x0 + before + (bb.x1 + bb.x2) / 2 * scale;
  const top = baseline - bb.y2 * scale;
  const s = size * 0.135; // meio-lado do losango
  const cy = top - s * 1.25;
  const dot = `<path d="M${cx} ${cy - s}L${cx + s} ${cy}L${cx} ${cy + s}L${cx - s} ${cy}Z" fill="${dotColor}"/>`;
  return { svg: `<path d="${p.toPathData(2)}" fill="${color}"/>` + dot, width: adv(text), iW };
}

function horizontal({ text = NAVY, long = BLUE, short = GREEN, dot = GREEN } = {}) {
  const size = 56, baseline = 54;
  const wm = wordmark(text, dot, 80, baseline, size);
  const W = Math.ceil(80 + wm.width + 4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 64" width="${W * 3}" height="192" role="img" aria-label="Verifco"><title>Verifco</title>${symbolPaths({ long, short })}${wm.svg}</svg>`;
}

const symbol = (o) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 66 64" width="264" height="256" role="img" aria-label="Verifco"><title>Verifco</title>${symbolPaths(o)}</svg>`;
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256" role="img" aria-label="Verifco"><title>Verifco</title><rect width="64" height="64" rx="14" fill="${NAVY}"/><g transform="translate(9.5 10.5) scale(0.68)">${symbolPaths({ long: WHITE, short: GREEN })}</g></svg>`;

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/verifco-logo.svg', horizontal());
fs.writeFileSync('out/verifco-logo-negativo.svg', horizontal({ text: WHITE, long: WHITE, short: GREEN, dot: GREEN }));
fs.writeFileSync('out/verifco-simbolo.svg', symbol());
fs.writeFileSync('out/verifco-icone-app.svg', appIcon);
fs.writeFileSync('out/preview.html', `<!doctype html><html><body style="margin:0;font-family:sans-serif">
<div style="padding:40px;background:#fff"><img src="verifco-logo.svg" height="96"></div>
<div style="padding:40px;background:${NAVY}"><img src="verifco-logo-negativo.svg" height="96"></div>
<div style="padding:40px;background:#F1F3F5;display:flex;gap:40px;align-items:center"><img src="verifco-simbolo.svg" height="128"><img src="verifco-icone-app.svg" height="128"><img src="verifco-icone-app.svg" height="32"><img src="verifco-simbolo.svg" height="24"><img src="verifco-logo.svg" height="32"></div>
</body></html>`);
console.log('ok');
