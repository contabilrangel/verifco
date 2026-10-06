import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicApi } from '../modules/checklist/customerApi';
import { ApiError, OFFLINE_MESSAGE, api, errorMessage } from './api';

/** Mensagem de erro única da interface (CON-15): escritório, portal e checklist usam `errorMessage`. */
describe('errorMessage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('usa a mensagem da API, a de sem conexão ou o texto padrão', () => {
    expect(errorMessage(new ApiError(400, 'CPF inválido.'))).toBe('CPF inválido.');
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(OFFLINE_MESSAGE);
    expect(errorMessage(new Error('boom'))).toBe('Não foi possível concluir. Tente de novo.');
    expect(errorMessage(undefined, 'Não foi possível enviar o logo.')).toBe('Não foi possível enviar o logo.');
    expect(errorMessage(new ApiError(500, ''), 'Tente atualizar.')).toBe('Tente atualizar.');
  });

  it('sem rede, o cliente do escritório e o do cliente final dão a mesma mensagem em português', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const office = await api.get('/office').catch((e: unknown) => e);
    const customer = await publicApi.post('/portal/login', {}).catch((e: unknown) => e);
    for (const err of [office, customer]) {
      expect(err).toBeInstanceOf(ApiError);
      expect(errorMessage(err)).toBe(OFFLINE_MESSAGE);
    }
  });
});
