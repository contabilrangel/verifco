import { describe, expect, it } from 'vitest';
import { PROCURATOR_ACCESS, PROCURATOR_ACCESS_SEVERITY, certificateDaysLeft, classifyProcuratorAccess, type ProcuratorAccessInput } from '../src';

const TODAY = '2026-10-06';
const cert = (over: Partial<ProcuratorAccessInput> = {}): ProcuratorAccessInput => ({
  authType: 'certificate_cloud',
  hasCertificate: true,
  certificateExpiresAt: '2027-06-30',
  loginStatus: 'unknown',
  ...over,
});

describe('situação do acesso do procurador', () => {
  it('gov.br fica sem verificação (o login acontece no navegador)', () => {
    expect(classifyProcuratorAccess({ ...cert(), authType: 'govbr', certificateExpiresAt: '2020-01-01' }, TODAY)).toBe('govbr_unverified');
  });

  it('vencimento pela data de Brasília: vale até o dia da validade, aviso com até 30 dias', () => {
    expect(classifyProcuratorAccess(cert({ certificateExpiresAt: '2026-10-05' }), TODAY)).toBe('certificate_expired');
    expect(classifyProcuratorAccess(cert({ certificateExpiresAt: TODAY }), TODAY)).toBe('certificate_expiring');
    expect(classifyProcuratorAccess(cert({ certificateExpiresAt: '2026-11-05' }), TODAY)).toBe('certificate_expiring');
    expect(classifyProcuratorAccess(cert({ certificateExpiresAt: '2026-11-06' }), TODAY)).toBe('valid');
    expect(certificateDaysLeft('2026-11-05', TODAY)).toBe(30);
    expect(certificateDaysLeft('2026-10-01', TODAY)).toBe(-5);
    expect(certificateDaysLeft(null, TODAY)).toBeNull();
  });

  it('certificado na nuvem sem arquivo, falhas e sucesso do login no SERPRO', () => {
    expect(classifyProcuratorAccess(cert({ hasCertificate: false }), TODAY)).toBe('certificate_missing');
    // instalado no computador: não há arquivo no Verifco para cobrar
    expect(classifyProcuratorAccess(cert({ authType: 'certificate_local', hasCertificate: false }), TODAY)).toBe('valid');
    expect(classifyProcuratorAccess(cert({ loginStatus: 'error' }), TODAY)).toBe('serpro_error');
    expect(classifyProcuratorAccess(cert({ loginStatus: 'expired', certificateExpiresAt: null }), TODAY)).toBe('certificate_expired');
    expect(classifyProcuratorAccess(cert({ loginStatus: 'ok' }), TODAY)).toBe('serpro_ok');
    // o aviso de vencimento vale mesmo com o login em dia
    expect(classifyProcuratorAccess(cert({ loginStatus: 'ok', certificateExpiresAt: '2026-10-20' }), TODAY)).toBe('certificate_expiring');
    expect(classifyProcuratorAccess(cert({ certificateExpiresAt: null }), TODAY)).toBe('expiry_unknown');
  });

  it('toda situação tem rótulo e gravidade', () => {
    for (const k of Object.keys(PROCURATOR_ACCESS)) expect(PROCURATOR_ACCESS_SEVERITY[k as keyof typeof PROCURATOR_ACCESS]).toBeTruthy();
  });
});
