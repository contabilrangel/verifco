/**
 * Leitura do relatório de situação fiscal (SITFIS): texto do PDF e interpretação conservadora.
 * O exemplo oficial do SERPRO (fixtures/sitfis-exemplo-serpro.pdf) vem com todos os dados
 * mascarados (999.999.999-99, ZZZZ, 99/99/9999); os demais relatórios são sintéticos e fictícios.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpretSitfis, pdfText, readSitfisReport } from '../src/modules/ecac/sitfis';
import { sitfisPendingPdf, sitfisRegularPdf, unknownLayoutPdf } from './sitfis-helpers';

/** PDF mínimo escrito à mão, sem compressão, com um content stream qualquer. */
function rawPdf(content: string): Buffer {
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj',
      `5 0 obj << /Length ${Buffer.byteLength(content, 'latin1')} >>`,
      'stream',
      content,
      'endstream',
      'endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n'),
    'latin1',
  );
}

describe('texto do PDF do relatório', () => {
  it('lê o exemplo oficial do SERPRO (fonte TrueType com ToUnicode) e junta os trechos da mesma linha', () => {
    const text = pdfText(readFileSync(new URL('./fixtures/sitfis-exemplo-serpro.pdf', import.meta.url)));
    expect(text).toContain('INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO');
    expect(text.split('\n')).toContain('Certidão Negativa: ZZZZ.ZZZZ.ZZZZ.ZZZZ Emissão: 99/99/9999 Data de Validade: 99/99/9999');
  });

  it('strings literais com parênteses aninhados, escapes e afastamentos do TJ', () => {
    const content = [
      'BT /F1 10 Tf 1 0 0 1 50 700 Tm (Pend\\352ncia - D\\351bito (SIEF)) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 50 680 Tm [(Receita)-400(0211)] TJ 120 0 Td (\\(detalhe\\)) Tj ET',
      'BT /F1 10 Tf 1 0 0 1 50 660 Tm <50656E64EA6E6369612096204F6D697373E36F> Tj ET',
    ].join('\n');
    expect(pdfText(rawPdf(content)).split('\n')).toEqual(['Pendência - Débito (SIEF)', 'Receita 0211 (detalhe)', 'Pendência – Omissão']);
  });

  it('o que não é PDF, ou está corrompido, vira texto vazio sem erro', () => {
    expect(pdfText(Buffer.from('não é PDF'))).toBe('');
    expect(pdfText(Buffer.from('%PDF-1.7\n1 0 obj << /Length 999 /Filter /FlateDecode >>\nstream\n\x00\x01lixo'))).toBe('');
    expect(pdfText(Buffer.from('%PDF-1.4\n%%EOF'))).toBe('');
  });
});

describe('interpretação do relatório SITFIS', () => {
  it('regular: o exemplo oficial, sem inventar código nem datas mascaradas', () => {
    const r = readSitfisReport(readFileSync(new URL('./fixtures/sitfis-exemplo-serpro.pdf', import.meta.url)));
    expect(r).toMatchObject({ readable: true, status: 'regular', pendencies: [] });
    expect(r.message).toMatch(/^Não foram detectadas pendências\/exigibilidades suspensas nos controles da Receita Federal/);
    expect(r.certificate).toEqual({ type: 'Negativa', code: null, issuedAt: null, validUntil: null });
  });

  it('regular: relatório sintético com a certidão negativa vigente', async () => {
    const r = readSitfisReport(await sitfisRegularPdf());
    expect(r).toMatchObject({ readable: true, status: 'regular', pendencies: [] });
    expect(r.certificate).toEqual({ type: 'Negativa', code: '1A2B.3C4D.5E6F.7A8B', issuedAt: '2026-03-02', validUntil: '2099-08-29' });
  });

  it('com pendências: lista as pendências (sem as linhas de detalhe) e a certidão informada', async () => {
    const r = readSitfisReport(await sitfisPendingPdf());
    expect(r).toMatchObject({ readable: true, status: 'pending', message: null });
    expect(r.pendencies).toEqual(['Pendência - Débito (SIEF)', 'Pendência – Omissão de Declaração']);
    expect(r.certificate).toEqual({ type: 'Positiva com Efeitos de Negativa', code: '9F8E.7D6C.5B4A.3210', issuedAt: '2026-01-10', validUntil: '2026-07-09' });
  });

  it('pendência vence a frase de "sem pendências" de um dos órgãos', () => {
    const r = interpretSitfis('Não foram detectadas pendências na Procuradoria-Geral da Fazenda Nacional.\nPendência - Débito (SIEF)');
    expect(r).toMatchObject({ status: 'pending', pendencies: ['Pendência - Débito (SIEF)'] });
  });

  it('layout desconhecido ou ilegível: "não interpretado", sem deduzir nada', async () => {
    expect(readSitfisReport(await unknownLayoutPdf())).toEqual({ readable: true, status: 'unknown', message: null, pendencies: [], certificate: null });
    expect(readSitfisReport(Buffer.from('%PDF-1.4\n% relatório de situação fiscal\n%%EOF\n'))).toEqual({ readable: false, status: 'unknown', message: null, pendencies: [], certificate: null });
    expect(readSitfisReport(Buffer.alloc(0))).toMatchObject({ readable: false, status: 'unknown' });
    // datas impossíveis e código mascarado não viram dado
    const masked = interpretSitfis('Certidão Emitida\nCertidão Negativa: ZZZZ.ZZZZ\nEmissão: 31/02/2026 Data de Validade: 99/99/9999');
    expect(masked).toMatchObject({ status: 'unknown', certificate: { type: 'Negativa', code: null, issuedAt: null, validUntil: null } });
  });

  it('limita a lista de pendências e o tamanho de cada linha', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Pendência - Débito ${i} ${'x'.repeat(300)}`);
    const r = interpretSitfis(lines.join('\n'));
    expect(r.pendencies).toHaveLength(30);
    expect(Math.max(...r.pendencies.map((p) => p.length))).toBe(200);
  });
});
