import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CarneLeaoCodeTables } from './CashbookTab';

/** COB-9: tabelas de códigos do Carnê-Leão no passo 2 do livro caixa, com busca e validade por ano. */
afterEach(cleanup);

const rows = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent);

describe('tabelas de códigos do Carnê-Leão', () => {
  it('lista os rendimentos e busca por código ou descrição, sem acento', () => {
    render(<CarneLeaoCodeTables year={2025} />);
    expect(rows()).toEqual([
      'R01.001.001Trabalho não assalariado',
      'R01.001.002Serviços notariais e de registro',
      'R01.002.001Pensão alimentícia',
      'R01.003.001Aluguel',
      'R01.004.001Outros',
    ]);
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: 'pensao' } });
    expect(rows()).toEqual(['R01.002.001Pensão alimentícia']);
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: 'R01.003' } });
    expect(rows()).toEqual(['R01.003.001Aluguel']);
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: 'xyz' } });
    expect(rows()).toEqual(['Nenhum código encontrado na tabela de 2025.']);
  });

  it('mostra só os códigos que valem no ano-calendário', () => {
    render(<CarneLeaoCodeTables year={2024} />);
    fireEvent.change(screen.getByLabelText('Tabela'), { target: { value: 'occupation' } });
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: 'fisioterapeuta' } });
    expect(rows()).toEqual(['231Fisioterapeuta']);
    cleanup();

    render(<CarneLeaoCodeTables year={2023} />);
    fireEvent.change(screen.getByLabelText('Tabela'), { target: { value: 'occupation' } });
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: 'fisioterapeuta' } });
    expect(rows()).toEqual(['229Fonoaudiólogo, fisioterapeuta, terapeuta ocupacional e afins']);
    // imposto pago: até 2025
    fireEvent.change(screen.getByLabelText('Tabela'), { target: { value: 'generalPayment' } });
    fireEvent.change(screen.getByLabelText('Buscar código ou descrição'), { target: { value: '' } });
    expect(rows()).toContain('P20.01.00004Imposto pago');
    cleanup();

    render(<CarneLeaoCodeTables year={2026} />);
    fireEvent.change(screen.getByLabelText('Tabela'), { target: { value: 'generalPayment' } });
    expect(rows()).not.toContain('P20.01.00004Imposto pago');
    fireEvent.change(screen.getByLabelText('Tabela'), { target: { value: 'chart' } });
    expect(rows()).toHaveLength(32);
  });
});
