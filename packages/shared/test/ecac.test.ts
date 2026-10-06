import { describe, expect, it } from 'vitest';
import { exerciseYearFromPath, parseIrpfFileName, syncFileTypeFromName } from '../src';

describe('arquivos do programa IRPF', () => {
  it('reconhece o padrão de nomes do programa', () => {
    expect(parseIrpfFileName('52998224725-IRPF-A-2026-2025-ORIGI.DEC')).toEqual({
      cpf: '52998224725',
      exerciseYear: 2026,
      calendarYear: 2025,
      type: 'dec',
      rectification: false,
      pattern: 'irpf',
    });
    const rec = parseIrpfFileName('C:\\Arquivos\\IRPF2026\\transmitidas\\52998224725-IRPF-A-2026-2025-RETIF.REC');
    expect(rec.cpf).toBe('52998224725');
    expect(rec.type).toBe('rec');
    expect(rec.rectification).toBe(true);
    const dbk = parseIrpfFileName('/home/ana/52998224725-irpf-2026-2025-origi.dbk');
    expect(dbk.exerciseYear).toBe(2026);
    expect(dbk.type).toBe('dbk');
    expect(parseIrpfFileName('52998224725-IRPF-A-2026-2025-ORIGI (1).DEC').cpf).toBe('52998224725');
  });

  it('aceita CPF no início do nome e lê o ano quando houver', () => {
    const info = parseIrpfFileName('529.982.247-25 informe banco 2026.pdf');
    expect(info).toMatchObject({ cpf: '52998224725', exerciseYear: 2026, type: 'pdf', pattern: 'cpf_prefix' });
    expect(parseIrpfFileName('52998224725_recibo.pdf').exerciseYear).toBeNull();
  });

  it('não inventa CPF: dígitos verificadores inválidos ou nomes fora do padrão', () => {
    expect(parseIrpfFileName('12345678900-IRPF-A-2026-2025-ORIGI.DEC').cpf).toBeNull();
    expect(parseIrpfFileName('declaracao.dec')).toMatchObject({ cpf: null, pattern: null, type: 'dec' });
    expect(parseIrpfFileName('5299822472512.pdf').cpf).toBeNull();
  });

  it('tipo pela extensão e ano pela pasta IRPF<ano>', () => {
    expect(syncFileTypeFromName('a.XML')).toBe('xml');
    expect(syncFileTypeFromName('a.txt')).toBe('other');
    expect(exerciseYearFromPath('C:\\Arquivos de Programas RFB\\IRPF2026\\transmitidas\\x.DEC')).toBe(2026);
    expect(exerciseYearFromPath('/home/ana/ProgramasRFB/IRPF2025/x.dbk')).toBe(2025);
    expect(exerciseYearFromPath('/tmp/x.dbk')).toBeNull();
  });
});
