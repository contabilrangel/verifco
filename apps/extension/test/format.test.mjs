// Funções puras de lib/format.js. Rodar: node --test (na pasta apps/extension).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/format.js';

const F = globalThis.VerifcoFormat;

test('CPF: dígitos, máscara e validação', () => {
  assert.equal(F.onlyDigits('529.982.247-25'), '52998224725');
  assert.equal(F.onlyDigits(null), '');
  assert.equal(F.formatCpf('52998224725'), '529.982.247-25');
  assert.equal(F.formatCpf('11222333000181'), '11.222.333/0001-81');
  assert.equal(F.formatCpf('123'), '123');
  assert.equal(F.isValidCpf('529.982.247-25'), true);
  assert.equal(F.isValidCpf('52998224724'), false);
  assert.equal(F.isValidCpf('11111111111'), false);
  assert.equal(F.isValidCpf('5299822472'), false);
  assert.equal(F.isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(F.isValidCnpj('11222333000180'), false);
  assert.equal(F.isValidCpfCnpj('52998224725'), true);
  assert.equal(F.isValidCpfCnpj(''), false);
});

test('maskCpf não revela o número inteiro', () => {
  assert.equal(F.maskCpf('52998224725'), '***.982.247-**');
  assert.equal(F.maskCpf('11222333000181'), '**.222.333/****-**');
  assert.equal(F.maskCpf('12'), '***');
  assert.equal(F.maskCpf(''), '');
});

test('originOf aceita só http(s)', () => {
  assert.equal(F.originOf(' https://app.exemplo.com.br/clientes?x=1 '), 'https://app.exemplo.com.br');
  assert.equal(F.originOf('http://localhost:5106/'), 'http://localhost:5106');
  assert.equal(F.originOf('ftp://exemplo.com'), null);
  assert.equal(F.originOf('exemplo'), null);
});

test('anos e datas', () => {
  assert.equal(F.currentExerciseYear(new Date(2026, 10, 11)), 2026);
  assert.equal(F.parseYear('2026'), 2026);
  assert.equal(F.parseYear(' 2025 '), 2025);
  assert.equal(F.parseYear('26'), null);
  assert.equal(F.parseYear('1999'), null);
  assert.equal(F.parseYear('2101'), null);
  assert.equal(F.parseYear(''), null);
  assert.equal(F.isIsoDate('2026-10-01'), true);
  assert.equal(F.isIsoDate('2026-02-30'), false);
  assert.equal(F.isIsoDate('01/10/2026'), false);
});

test('cleanText e truncateText', () => {
  assert.equal(F.cleanText('  a \t b \r\n\n\n\n c  '), 'a b\n\nc');
  assert.deepEqual(F.truncateText('abc', 3), { text: 'abc', truncated: false });
  const cut = F.truncateText('abcdefghij', 5);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, 'abcd…');
  assert.equal(cut.text.length, 5);
});

test('normalizeCustomer aceita o formato novo e o antigo', () => {
  assert.deepEqual(F.normalizeCustomer({ cpf: '529.982.247-25', name: ' Ana ', procurationStatus: 'valid', hasProcurator: false }), {
    cpf: '52998224725',
    name: 'Ana',
    procurationStatus: 'valid',
    hasProcurator: false,
  });
  assert.equal(F.normalizeCustomer({ cpf: '52998224725', name: 'Ana', procurator: { name: 'P' } }).hasProcurator, true);
  assert.equal(F.normalizeCustomer({ name: 'Sem CPF' }), null);
});

test('filterCustomers procura por nome sem acento ou por dígitos do CPF', () => {
  const list = [
    { cpf: '52998224725', name: 'João Antônio' },
    { cpf: '11144477735', name: 'Maria' },
    { cpf: '39053344705', name: 'Joana' },
  ];
  assert.deepEqual(F.filterCustomers(list, 'joao').map((c) => c.name), ['João Antônio']);
  assert.deepEqual(F.filterCustomers(list, 'JO').map((c) => c.name), ['João Antônio', 'Joana']);
  assert.deepEqual(F.filterCustomers(list, '111.444').map((c) => c.name), ['Maria']);
  assert.equal(F.filterCustomers(list, '').length, 3);
  assert.equal(F.filterCustomers(list, '', 2).length, 2);
  assert.equal(F.filterCustomers(list, 'zzz').length, 0);
});

test('resolveClient: vale o mais recente entre o escolhido e o "Acessar"', () => {
  const ttl = 30 * 60 * 1000;
  const now = 1_000_000_000;
  const sel = { cpf: '52998224725', name: 'Ana', at: now - 1000 };
  assert.equal(F.resolveClient(null, null, now, ttl), null);
  assert.deepEqual(F.resolveClient(sel, null, now, ttl), { cpf: '52998224725', name: 'Ana', source: 'selected' });
  // "Acessar" de outro cliente, depois da escolha: vale o "Acessar"
  assert.deepEqual(F.resolveClient(sel, { cpf: '11144477735', at: now - 10 }, now, ttl), { cpf: '11144477735', name: null, source: 'context' });
  // "Acessar" mais antigo que a escolha: vale a escolha
  assert.equal(F.resolveClient(sel, { cpf: '11144477735', at: now - 5000 }, now, ttl).source, 'selected');
  // mesmo CPF: fica o escolhido, que tem o nome
  assert.equal(F.resolveClient(sel, { cpf: '52998224725', at: now - 10 }, now, ttl).name, 'Ana');
  // "Acessar" vencido não conta
  assert.equal(F.resolveClient(null, { cpf: '11144477735', at: now - ttl - 1 }, now, ttl), null);
  // "Acessar" sem CPF não conta
  assert.equal(F.resolveClient(null, { cpf: '', at: now }, now, ttl), null);
});

test('appendLog: mais novo primeiro, CPF mascarado, tamanho limitado', () => {
  let list = [];
  for (let i = 0; i < 35; i += 1) list = F.appendLog(list, { at: i + 1, cpf: '52998224725', name: 'Ana', what: `envio ${i}`, ok: i % 2 === 0, detail: 'x' }, 30);
  assert.equal(list.length, 30);
  assert.equal(list[0].what, 'envio 34');
  assert.equal(list[0].cpf, '***.982.247-**');
  assert.equal(list[0].ok, true);
  assert.equal(JSON.stringify(list).includes('52998224725'), false);
  assert.equal(F.appendLog(null, { what: 'a', ok: false }).length, 1);
});

test('formatWhen e formatBytes', () => {
  const now = new Date(2026, 10, 11, 15, 0);
  assert.equal(F.formatWhen(new Date(2026, 10, 11, 9, 5).getTime(), now), 'hoje 09:05');
  assert.equal(F.formatWhen(new Date(2026, 10, 9, 14, 30).getTime(), now), '09/11 14:30');
  assert.equal(F.formatWhen('x', now), '');
  assert.equal(F.formatBytes(500), '500 B');
  assert.equal(F.formatBytes(2048), '2 KB');
  assert.equal(F.formatBytes(25 * 1024 * 1024), '25,0 MB');
});

test('nome de arquivo: cabeçalho, URL e extensão pelo tipo', () => {
  assert.equal(F.fileNameFromDisposition('attachment; filename="recibo 2026.pdf"'), 'recibo 2026.pdf');
  assert.equal(F.fileNameFromDisposition("attachment; filename=x.pdf; filename*=UTF-8''certid%C3%A3o.pdf"), 'certidão.pdf');
  assert.equal(F.fileNameFromDisposition('attachment; filename=../../etc/passwd'), 'passwd');
  assert.equal(F.fileNameFromDisposition('inline'), null);
  assert.equal(F.fileNameFromUrl('https://exemplo.gov.br/docs/darf%20quota.pdf?x=1'), 'darf quota.pdf');
  assert.equal(F.fileNameFromUrl('https://exemplo.gov.br/'), null);
  assert.equal(F.fileNameFromUrl('javascript:void(0)'), null);
  assert.equal(F.extensionForMime('application/pdf; charset=binary'), 'pdf');
  assert.equal(F.pickFileName({ disposition: null, url: 'https://x.gov.br/emitir', mime: 'application/pdf' }), 'emitir.pdf');
  assert.equal(F.pickFileName({ disposition: 'attachment; filename="a.pdf"', url: 'https://x.gov.br/emitir', mime: 'application/pdf' }), 'a.pdf');
  assert.equal(F.pickFileName({ disposition: null, url: 'https://x.gov.br/', mime: 'image/png' }), 'arquivo.png');
  assert.equal(F.sanitizeFileName(`${'a'.repeat(300)}.pdf`).length, 200);
  assert.ok(F.sanitizeFileName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf'));
});

test('pickMenuUrl: link, depois imagem, depois a página (só quando pedido)', () => {
  assert.equal(F.pickMenuUrl({ linkUrl: 'https://a/x.pdf', srcUrl: 'https://a/i.png' }), 'https://a/x.pdf');
  assert.equal(F.pickMenuUrl({ linkUrl: 'javascript:void(0)', srcUrl: 'https://a/i.png' }), 'https://a/i.png');
  assert.equal(F.pickMenuUrl({ pageUrl: 'https://a/doc.pdf' }), null);
  assert.equal(F.pickMenuUrl({ pageUrl: 'https://a/doc.pdf' }, true), 'https://a/doc.pdf');
  assert.equal(F.pickMenuUrl({ linkUrl: 'blob:https://a/123' }), null);
  assert.equal(F.pickMenuUrl({}), null);
});
