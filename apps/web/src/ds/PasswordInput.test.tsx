import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PasswordInput } from './index';

afterEach(cleanup);

describe('PasswordInput', () => {
  it('começa oculto e alterna entre mostrar e ocultar a senha', () => {
    render(<PasswordInput label="Senha" autoComplete="current-password" defaultValue="segredo123" />);
    const input = screen.getByLabelText('Senha') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('current-password');

    const toggle = screen.getByRole('button', { name: 'Mostrar senha' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(input.id);

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(input.value).toBe('segredo123');
    expect(screen.getByRole('button', { name: 'Ocultar senha' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(input.type).toBe('password');
  });

  it('o botão não envia o formulário', () => {
    let submitted = 0;
    render(
      <form onSubmit={(e) => { e.preventDefault(); submitted++; }}>
        <PasswordInput label="Senha" />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(submitted).toBe(0);
  });
});
