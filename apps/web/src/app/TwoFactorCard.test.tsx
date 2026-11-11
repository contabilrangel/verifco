import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../ds';
import { ApiError } from '../lib/api';
import { QrCode, TwoFactorCard } from './TwoFactorCard';

afterEach(cleanup);

const URL_OTP = 'otpauth://totp/Verifco%3Aana%40teste.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Verifco&algorithm=SHA1&digits=6&period=30';

describe('verificação em duas etapas (cartão da conta)', () => {
  it('desenha o QR code do endereço otpauth com os três marcadores de canto', () => {
    const { container } = render(<QrCode value={URL_OTP} />);
    const svg = container.querySelector('svg')!;
    const [, , w] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    const n = w - 8;
    // versões do QR: 21, 25, 29... módulos de lado
    expect((n - 21) % 4).toBe(0);
    const dark = new Set([...container.querySelectorAll('rect[fill="#000"]')].map((r) => `${r.getAttribute('y')},${r.getAttribute('x')}`));
    // canto superior esquerdo do marcador de posição: linha e coluna cheias de 7 módulos (margem 4)
    for (let i = 0; i < 7; i++) {
      expect(dark.has(`4,${4 + i}`)).toBe(true);
      expect(dark.has(`${4 + i},4`)).toBe(true);
      expect(dark.has(`4,${4 + n - 7 + i}`)).toBe(true);
      expect(dark.has(`${4 + n - 7 + i},4`)).toBe(true);
    }
  });

  it('ativa: senha, QR code com a chave para digitar, código e códigos de recuperação mostrados uma vez', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const post = vi.fn(async (path: string, body: unknown) => {
      calls.push({ path, body });
      if (path === '/2fa/setup') return { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', otpauthUrl: URL_OTP };
      if (path === '/2fa/enable') return { recoveryCodes: ['abcd-efgh-jkmn', 'pqrs-tuvw-xyz2'] };
      return {};
    });
    const onChange = vi.fn();
    render(
      <ToastProvider>
        <TwoFactorCard enabled={false} post={post as never} onChange={onChange} />
      </ToastProvider>,
    );
    expect(screen.getByText('Desativada')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ativar' }));
    fireEvent.change(await screen.findByLabelText('Confirme a sua senha atual'), { target: { value: 'minha-senha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByRole('img', { name: 'QR code para o aplicativo autenticador' })).toBeTruthy();
    expect(screen.getByText('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')).toBeTruthy();
    const activate = screen.getAllByRole('button', { name: 'Ativar' }).at(-1) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Digite o código de 6 dígitos/), { target: { value: '123 456' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Ativar' }).at(-1)!);
    expect(await screen.findByText(/abcd-efgh-jkmn/)).toBeTruthy();
    expect(calls).toEqual([
      { path: '/2fa/setup', body: { password: 'minha-senha' } },
      { path: '/2fa/enable', body: { code: '123 456' } },
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('desativa com senha e código; erro da API aparece no diálogo', async () => {
    const post = vi.fn(async () => {
      throw new ApiError(400, 'Código inválido.');
    });
    render(
      <ToastProvider>
        <TwoFactorCard enabled post={post as never} onChange={() => {}} />
      </ToastProvider>,
    );
    expect(screen.getByText('Ativa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desativar' }));
    fireEvent.change(await screen.findByLabelText('Senha atual'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText(/Código do aplicativo ou um código de recuperação/), { target: { value: '000000' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Desativar' }).at(-1)!);
    await waitFor(() => expect(screen.getByText('Código inválido.')).toBeTruthy());
    expect(post).toHaveBeenCalledWith('/2fa/disable', { password: 's', code: '000000' });
  });
});
