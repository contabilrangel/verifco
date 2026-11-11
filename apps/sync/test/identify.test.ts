import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { classifyFile, exerciseYearFromPath, parseFileName, sniffHeader } from '../src/identify';
import { irpfHeader } from './helpers';
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

// ---------------------------------------------------------------- cabeçalho do conteúdo (leitura conservadora)

test('cabeçalho válido: anos coerentes e CPF com dígitos verificadores', () => {
  const h = sniffHeader(irpfHeader(2026, '52998224725'));
  assert.deepEqual(h, { exerciseYear: 2026, calendarYear: 2025, cpfAtExpectedPlace: '52998224725', cpfCandidates: ['52998224725'] });
  // texto ou bytes (latin1), e só a primeira linha conta
  assert.deepEqual(sniffHeader(irpfHeader(2026, '52998224725').toString('latin1')), h);
  assert.deepEqual(sniffHeader(Buffer.concat([irpfHeader(2025, '11144477735'), Buffer.from('linha 2 52998224725\r\n')]))?.cpfCandidates, ['11144477735']);
});

test('cabeçalho: lixo, outros formatos e anos incoerentes não dizem nada', () => {
  assert.equal(sniffHeader(null), null);
  assert.equal(sniffHeader(Buffer.alloc(0)), null);
  assert.equal(sniffHeader(Buffer.from('%PDF-1.7\n52998224725')), null);
  assert.equal(sniffHeader('<?xml version="1.0"?><cpf>52998224725</cpf>'), null);
  assert.equal(sniffHeader(Buffer.from([0xff, 0xfe, 0x00, 0x49, 0x52, 0x50, 0x46, 0x9c, 0x00, 0x01])), null);
  assert.equal(sniffHeader('IRPF 2026202536000' + '52998224725'), null); // um espaço só
  assert.equal(sniffHeader('IRPF    2026202436000' + '52998224725'), null); // calendário ≠ exercício − 1
  assert.equal(sniffHeader('IRPF    1999199836000' + '52998224725'), null);
  assert.equal(sniffHeader(' IRPF    2026202536000' + '52998224725'), null); // a marca tem de abrir o arquivo
  // marca certa, mas sem CPF válido no lugar esperado: os anos valem, o CPF não
  assert.deepEqual(sniffHeader('IRPF    2026202536000' + '98765432101' + '   X'), { exerciseYear: 2026, calendarYear: 2025, cpfAtExpectedPlace: null, cpfCandidates: [] });
  // uma janela de 11 dígitos pode passar nos dígitos verificadores por acaso ("0" + "1234567890"):
  // ela aparece como candidata, mas fora do lugar esperado não identifica ninguém
  const chance = 'IRPF    2026202536000' + '12345678900' + '   X';
  assert.deepEqual(sniffHeader(chance)?.cpfCandidates, ['01234567890']);
  assert.equal(sniffHeader(chance)?.cpfAtExpectedPlace, null);
  assert.equal(classifyFile('/x/declaracao.DEC', { header: chance }).cpf, null);
});

test('o cabeçalho confirma o CPF do nome e não muda nada', () => {
  const c = classifyFile('/x/52998224725-IRPF-A-2026-2025-ORIGI.DEC', { header: irpfHeader(2026, '52998224725') });
  assert.equal(c.cpf, '52998224725');
  assert.equal(c.cpfSource, 'nome');
  assert.equal(c.cpfMismatch, false);
  assert.equal(c.year, 2026);
  assert.equal(c.yearSource, 'nome');
  assert.equal(c.skipReason, null);
});

test('CPF do nome diferente do CPF do cabeçalho: não é enviado a nenhum cliente', () => {
  const c = classifyFile('/x/11144477735-IRPF-A-2026-2025-ORIGI.DEC', { header: irpfHeader(2026, '52998224725') });
  assert.equal(c.cpfMismatch, true);
  assert.equal(c.cpf, '11144477735');
  assert.equal(c.headerCpf, '52998224725');
  assert.match(c.skipReason ?? '', /CPF do nome \(11144477735\) é diferente do CPF do conteúdo \(52998224725\)/);
  // o CPF do nome aparecendo em outro ponto da linha não é divergência (leitura tímida)
  const other = classifyFile('/x/11144477735-IRPF-A-2026-2025-ORIGI.DEC', { header: irpfHeader(2026, '52998224725', ' 11144477735 ') });
  assert.equal(other.cpfMismatch, false);
  assert.equal(other.skipReason, null);
  // dígitos sem validade no lugar esperado também não
  assert.equal(classifyFile('/x/11144477735-IRPF-A-2026-2025-ORIGI.DEC', { header: irpfHeader(2026, '12345678900') }).cpfMismatch, false);
});

test('sem CPF no nome: o cabeçalho só vale com exatamente um candidato', () => {
  const one = classifyFile('/x/declaracao da maria.DEC', { header: irpfHeader(2026, '52998224725') });
  assert.equal(one.cpf, '52998224725');
  assert.equal(one.cpfSource, 'conteúdo');
  assert.equal(one.year, 2026);
  assert.equal(one.yearSource, 'conteúdo');
  assert.equal(one.skipReason, null);

  const two = classifyFile('/x/declaracao.DEC', { header: irpfHeader(2026, '52998224725', ' 11144477735 ') });
  assert.equal(two.cpf, null);
  assert.match(two.skipReason ?? '', /CPF não identificado/);
  assert.equal(two.year, 2026); // o ano continua valendo

  const none = classifyFile('/x/declaracao.DEC', { header: Buffer.from('qualquer coisa 52998224725') });
  assert.equal(none.cpf, null);
  assert.equal(none.year, null);
});

test('ano: nome, depois cabeçalho, depois pasta', () => {
  const header = irpfHeader(2025, '52998224725');
  assert.equal(classifyFile('/p/IRPF2026/52998224725-IRPF-A-2026-2025-ORIGI.DEC', { header }).year, 2026);
  assert.equal(classifyFile('/p/IRPF2026/52998224725-IRPF-A-2026-2025-ORIGI.DEC', { header }).headerYear, 2025);
  const byHeader = classifyFile('/p/IRPF2026/52998224725 copia.DBK', { header });
  assert.equal(byHeader.year, 2025);
  assert.equal(byHeader.yearSource, 'conteúdo');
  const byFolder = classifyFile('/p/IRPF2026/52998224725 copia.DBK', { header: Buffer.from('outro formato') });
  assert.equal(byFolder.year, 2026);
  assert.equal(byFolder.yearSource, 'pasta');
});
