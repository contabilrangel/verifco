import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../ds';
import { PreferencesTab } from './PreferencesTab';

/** Seção "Lembretes" das preferências: dias de antecedência (0 a 30, 0 = não lembrar) e as duas chaves. */
const auth = vi.hoisted(() => ({ canEdit: true }));
vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ can: (p: string) => p !== 'settings.edit' || auth.canEdit, me: { favorites: [] }, refresh: async () => {} }),
}));
vi.mock('../../lib/year', () => ({ useYear: () => ({ year: 2026 }) }));

const baseSettings = {
  restrictCustomersToResponsible: false,
  autoSendDarfEmail: false,
  notifyMainEmailOnEcacChanges: false,
  simplifiedQueryWithoutProcurator: false,
  autoGenerateCnd: false,
  receiptTwoCopies: false,
  receiptShowDetails: true,
  authorizationShowDetails: true,
  allowAuthorizationWithoutBudget: false,
  cashAnalysisSimplifiedDiscount: 'standard',
  checklistReadOnlyAfterStart: false,
  lockChecklistFromSubstatus: null,
  highNetWorthBaseCents: 300_000_000,
  reportTitleColor: '#0F2457',
  reportSubtitleColor: '#3468E6',
  reportLineColor: '#E1E4E8',
  whatsappServiceNumber: '',
};
const reminders = { reminderDarfCustomerDays: 3, reminderInstallmentCustomerDays: 2, reminderInstallmentOverdueCustomer: true, reminderOfficeDigest: true };
const server = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, saved: [] as Record<string, unknown>[] }));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const get = async (path: string) => {
    if (path === '/office') return { id: 'o1', name: 'Escritório Exemplo', logoFileId: null, settings: server.settings };
    throw new Error(`rota inesperada: ${path}`);
  };
  const put = async (path: string, body: Record<string, unknown>) => {
    if (path !== '/office/settings') throw new Error(`rota inesperada: ${path}`);
    server.saved.push(body);
    server.settings = { ...server.settings, ...body };
    return server.settings;
  };
  return { ...original, api: { ...original.api, get, put } };
});

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <PreferencesTab />
      </ToastProvider>
    </QueryClientProvider>,
  );

const section = async () => (await screen.findByRole('heading', { name: 'Lembretes' })).closest('section, .vf-card, div')!.parentElement as HTMLElement;
const darfDays = () => screen.getByLabelText(/Lembrar o cliente do DARF \(dias antes\)/) as HTMLInputElement;
const feeDays = () => screen.getByLabelText(/Lembrar o cliente dos honorários \(dias antes\)/) as HTMLInputElement;
const overdue = () => screen.getByRole('switch', { name: /Avisar o cliente quando a parcela dos honorários ficar vencida/ }) as HTMLInputElement;
const digest = () => screen.getByRole('switch', { name: /Avisar a equipe no sino sobre vencimentos/ }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Salvar preferências' }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  server.saved.length = 0;
  auth.canEdit = true;
});

describe('PreferencesTab: lembretes', () => {
  it('mostra as quatro preferências com o que o escritório tem gravado', async () => {
    server.settings = { ...baseSettings, ...reminders, reminderDarfCustomerDays: 5, reminderOfficeDigest: false };
    renderTab();
    await section();
    expect(darfDays().value).toBe('5');
    expect(feeDays().value).toBe('2');
    expect(darfDays().type).toBe('number');
    expect(darfDays().min).toBe('0');
    expect(darfDays().max).toBe('30');
    expect(overdue().checked).toBe(true);
    expect(digest().checked).toBe(false);
    expect(screen.getAllByText(/0 = não lembrar/).length).toBe(2);
    expect(save().disabled).toBe(true);
  });

  it('salva os dias e as chaves pela mesma ação das outras preferências', async () => {
    server.settings = { ...baseSettings, ...reminders };
    renderTab();
    await section();
    fireEvent.change(darfDays(), { target: { value: '7' } });
    fireEvent.change(feeDays(), { target: { value: '0' } });
    fireEvent.click(overdue());
    fireEvent.click(digest());
    expect(screen.getByText('Há alterações não salvas.')).toBeTruthy();
    fireEvent.click(save());
    await waitFor(() => expect(server.saved).toHaveLength(1));
    expect(server.saved[0]).toMatchObject({ reminderDarfCustomerDays: 7, reminderInstallmentCustomerDays: 0, reminderInstallmentOverdueCustomer: false, reminderOfficeDigest: false });
    // as demais preferências seguem no mesmo envio, como antes
    expect(server.saved[0]).toMatchObject({ receiptShowDetails: true, reportTitleColor: '#0F2457' });
    expect(await screen.findByText('Tudo salvo.')).toBeTruthy();
    expect(darfDays().value).toBe('7');
  });

  it('só aceita de 0 a 30 dias: valor inválido não muda a preferência e volta ao último válido', async () => {
    server.settings = { ...baseSettings, ...reminders };
    renderTab();
    await section();
    for (const bad of ['31', '-1', '2.5', '']) {
      fireEvent.change(darfDays(), { target: { value: bad } });
      expect(screen.getByText('Use um número de 0 a 30 (0 = não lembrar).')).toBeTruthy();
      // nada mudou: não há o que salvar
      expect(save().disabled).toBe(true);
    }
    fireEvent.blur(darfDays());
    expect(darfDays().value).toBe('3');
    expect(screen.queryByText('Use um número de 0 a 30 (0 = não lembrar).')).toBeNull();
    fireEvent.change(darfDays(), { target: { value: '30' } });
    expect(save().disabled).toBe(false);
  });

  it('escritório cuja resposta ainda não traz as chaves: usa os padrões; sem permissão, só consulta', async () => {
    server.settings = { ...baseSettings };
    auth.canEdit = false;
    renderTab();
    const el = await section();
    expect(darfDays().value).toBe('3');
    expect(feeDays().value).toBe('2');
    expect(overdue().checked).toBe(true);
    expect(digest().checked).toBe(true);
    expect(darfDays().disabled).toBe(true);
    expect(digest().disabled).toBe(true);
    expect(within(el).getByText(/enviados todo dia às 8h/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar preferências' })).toBeNull();
  });
});
