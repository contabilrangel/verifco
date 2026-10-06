import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { classifyFile, exerciseYearFromPath, parseFileName } from '../src/identify';
import { defaultIrpfFolders } from '../src/folders';

test('reconhece o padrão de nomes do programa IRPF', () => {
  assert.deepEqual(parseFileName('52998224725-IRPF-A-2026-2025-ORIGI.DEC'), {
    cpf: '52998224725',
    exerciseYear: 2026,
    calendarYear: 2025,
    type: 'dec',
    rectification: false,
    pattern: 'irpf',
  });
  const rec = parseFileName('52998224725-IRPF-A-2026-2025-RETIF.REC');
  assert.equal(rec.type, 'rec');
  assert.equal(rec.rectification, true);
  assert.equal(parseFileName('11144477735-irpf-2025-2024-origi.dbk').exerciseYear, 2025);
});

test('aceita CPF no início do nome e recusa CPF inválido', () => {
  assert.equal(parseFileName('529.982.247-25 informe 2026.pdf').cpf, '52998224725');
  assert.equal(parseFileName('529.982.247-25 informe 2026.pdf').exerciseYear, 2026);
  assert.equal(parseFileName('12345678900-IRPF-A-2026-2025-ORIGI.DEC').cpf, null);
  assert.equal(parseFileName('declaracao.dec').cpf, null);
});

test('ano pela pasta IRPF<ano> quando o nome não traz', () => {
  assert.equal(exerciseYearFromPath(join('/home/ana/ProgramasRFB/IRPF2026/transmitidas', 'x.dbk')), 2026);
  const c = classifyFile('/home/ana/ProgramasRFB/IRPF2026/52998224725_recibo.pdf');
  assert.equal(c.cpf, '52998224725');
  assert.equal(c.year, 2026);
  assert.equal(c.destination, 'files');
  assert.equal(c.skipReason, null);
});

test('motivo para ignorar e destino das pré-preenchidas', () => {
  assert.match(classifyFile('/tmp/declaracao.dec').skipReason ?? '', /CPF não identificado/);
  assert.match(classifyFile('/tmp/52998224725 informe.pdf').skipReason ?? '', /ano não identificado/);
  const pre = classifyFile('/dados/pre/52998224725-IRPF-A-2026-2025-ORIGI.DEC', { prefilledFolders: ['/dados/pre'] });
  assert.equal(pre.destination, 'prefilled');
});

test('pastas padrão do programa por sistema', () => {
  const now = new Date('2026-05-01T12:00:00Z');
  assert.deepEqual(defaultIrpfFolders({ now, platform: 'linux', home: '/home/ana' }), ['/home/ana/ProgramasRFB/IRPF2026', '/home/ana/ProgramasRFB/IRPF2025']);
  const win = defaultIrpfFolders({ now, platform: 'win32', home: 'C:\\Users\\Ana' });
  assert.ok(win.includes('C:\\Arquivos de Programas RFB\\IRPF2026'));
  assert.ok(win.includes('C:\\Users\\Ana\\ProgramasRFB\\IRPF2025'));
});
