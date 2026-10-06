import PDFDocument from 'pdfkit';
import { formatCpfCnpj } from '@verifco/shared';
import { VALID_CPFS } from './helpers';

/**
 * Relatórios SITFIS sintéticos para os testes: só dados fictícios (CPF de teste, "Contribuinte
 * Exemplo"), no texto do modelo oficial do SERPRO.
 */

/** PDF de texto simples (Helvetica, uma linha por `text`), como um relatório gerado por sistema. */
export function textPdf(lines: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Relatório de teste' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('Helvetica').fontSize(9);
  for (const l of lines) doc.text(l);
  doc.end();
  return done;
}

const header = (cpf: string) => [
  'MINISTÉRIO DA FAZENDA',
  'SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL',
  'PROCURADORIA-GERAL DA FAZENDA NACIONAL',
  'INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO',
  `CPF: ${formatCpfCnpj(cpf)} – CONTRIBUINTE EXEMPLO`,
];

/** Relatório sem pendências, com a certidão negativa vigente. */
export const sitfisRegularPdf = (cpf = VALID_CPFS[0]) =>
  textPdf([
    ...header(cpf),
    'Certidão Emitida ________________________________',
    'Certidão Negativa: 1A2B.3C4D.5E6F.7A8B',
    'Emissão: 02/03/2026',
    'Data de Validade: 29/08/2099',
    '______ Diagnóstico Fiscal na Receita Federal e Procuradoria-Geral da Fazenda Nacional ______',
    'Não foram detectadas pendências/exigibilidades suspensas nos controles da Receita Federal e da Procuradoria-Geral da Fazenda Nacional.',
    'Final do Relatório',
  ]);

/** Relatório com duas pendências (com linhas de detalhe) e a certidão positiva com efeitos de negativa. */
export const sitfisPendingPdf = (cpf = VALID_CPFS[0]) =>
  textPdf([
    ...header(cpf),
    'Certidão Emitida ________________________________',
    'Certidão Positiva com Efeitos de Negativa: 9F8E.7D6C.5B4A.3210',
    'Emissão: 10/01/2026',
    'Data de Validade: 09/07/2026',
    '______ Diagnóstico Fiscal na Receita Federal ______',
    'Pendência - Débito (SIEF)',
    'Receita PA/Exerc. Dt. Vcto Vl.Original Sdo.Devedor Situação',
    '0211-01 - IRPF 2025 30/05/2025 1,00 1,00 DEVEDOR',
    'Pendência – Omissão de Declaração',
    'DIRPF 2024',
    'Final do Relatório',
  ]);

/** PDF legível que não segue o modelo do relatório. */
export const unknownLayoutPdf = () => textPdf(['Relatório de teste em layout novo', 'Contribuinte Exemplo', 'Sem as frases do modelo oficial']);
