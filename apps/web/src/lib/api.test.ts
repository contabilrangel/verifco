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

/** Download de arquivos grandes (DAD-3): o backup pode ter alguns GB. */
describe('api.download', () => {
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it('salva a resposta como blob (que o navegador pode guardar em disco), sem montar um ArrayBuffer do arquivo', async () => {
    const arrayBuffer = vi.fn(() => Promise.reject(new RangeError('Array buffer allocation failed')));
    const body = new Blob(['PK-conteúdo do backup']);
    const blob = vi.fn(async () => body);
    const headers = new Headers({ 'content-type': 'application/zip', 'content-disposition': "attachment; filename*=UTF-8''backup-verifco-2026-10-06.zip" });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers, blob, arrayBuffer }));
    const saved: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => (saved.push(b as Blob), 'blob:backup'));
    URL.revokeObjectURL = vi.fn();
    let name = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    await api.download('/backups/1/download', 'backup.zip');
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(blob).toHaveBeenCalledTimes(1);
    expect(name).toBe('backup-verifco-2026-10-06.zip');
    // salvo como binário, com o conteúdo da resposta
    expect(saved[0].type).toBe('application/octet-stream');
    expect(saved[0].size).toBe(body.size);
  });
});
