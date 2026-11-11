import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CHAT_MAX_FILES, ChatThread, Composer, chatFileError, type ChatEntry } from './Chat';

/** Chat (painel e portal): anexar, conferir, remover e enviar arquivos; anexos das mensagens como links de download. */
afterEach(cleanup);

const file = (name: string, size = 1200, type = 'application/pdf') => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const pick = (...files: File[]) => fireEvent.change(screen.getByLabelText('Anexar arquivos'), { target: { files } });
const chosen = () => within(screen.getByRole('list', { name: 'Arquivos para enviar' })).getAllByRole('listitem').map((li) => li.textContent);

describe('Composer: anexos', () => {
  it('lista os arquivos escolhidos, deixa remover e envia o texto com os que ficaram', async () => {
    const onSend = vi.fn(async () => {});
    render(<Composer sending={false} onSend={onSend} />);
    expect(screen.getByRole('button', { name: 'Anexar' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Arquivos para enviar' })).toBeNull();

    pick(file('informe.pdf', 2048), file('recibo.png', 512_000, 'image/png'));
    pick(file('planilha.xlsx', 3 * 1024 * 1024));
    expect(chosen()).toEqual(['informe.pdf2 KB', 'recibo.png500 KB', 'planilha.xlsx3,0 MB']);

    fireEvent.click(screen.getByRole('button', { name: 'Remover recibo.png' }));
    expect(chosen()).toEqual(['informe.pdf2 KB', 'planilha.xlsx3,0 MB']);

    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: '  Seguem os documentos  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [text, viaWhatsApp, files] = onSend.mock.calls[0] as unknown as [string, boolean, File[]];
    expect(text).toBe('Seguem os documentos');
    expect(viaWhatsApp).toBe(false);
    expect(files.map((f) => f.name)).toEqual(['informe.pdf', 'planilha.xlsx']);
    // enviado: a caixa volta vazia
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Arquivos para enviar' })).toBeNull());
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe('');
  });

  it('mensagem só com anexo pode ser enviada; sem texto e sem anexo, não', async () => {
    const onSend = vi.fn(async () => {});
    render(<Composer sending={false} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    pick(file('foto.jpg', 900, 'image/jpeg'));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [text, , files] = onSend.mock.calls[0] as unknown as [string, boolean, File[]];
    expect(text).toBe('');
    expect(files).toHaveLength(1);
  });

  it('recusa tipo não aceito, arquivo grande ou vazio e o sexto arquivo, dizendo o motivo', () => {
    render(<Composer sending={false} onSend={async () => {}} />);

    pick(file('programa.exe'));
    expect(screen.getByRole('alert').textContent).toBe('“programa.exe” não é aceito. Envie PDF, imagem (JPG, PNG, HEIC) ou planilha (XLSX, XLS, ODS, CSV).');
    expect(screen.queryByRole('list', { name: 'Arquivos para enviar' })).toBeNull();

    pick(file('grande.pdf', 10 * 1024 * 1024 + 1));
    expect(screen.getByRole('alert').textContent).toBe('“grande.pdf” passa de 10 MB. Envie um arquivo menor.');
    pick(file('vazio.pdf', 0));
    expect(screen.getByRole('alert').textContent).toBe('“vazio.pdf” está vazio.');

    // os válidos entram mesmo quando outro do mesmo lote é recusado; no limite exato de 10 MB passa
    pick(file('limite.pdf', 10 * 1024 * 1024), file('notas.txt'));
    expect(chosen()).toEqual(['limite.pdf10,0 MB']);
    expect(screen.getByRole('alert').textContent).toContain('“notas.txt” não é aceito.');
    // um arquivo válido em seguida limpa o aviso
    pick(file('a.pdf'));
    expect(screen.queryByRole('alert')).toBeNull();

    pick(file('b.pdf'), file('c.pdf'), file('d.pdf'), file('e.pdf'));
    expect(chosen()).toHaveLength(CHAT_MAX_FILES);
    expect(screen.getByRole('alert').textContent).toBe('Cada mensagem leva no máximo 5 arquivos. “e.pdf” ficou de fora.');
    // remover um arquivo tira o aviso
    fireEvent.click(screen.getByRole('button', { name: 'Remover d.pdf' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chatFileError(file('ok.HEIC', 100, 'image/heic'))).toBeNull();
  });

  it('pelo WhatsApp: um anexo por mensagem e sempre com texto', async () => {
    const onSend = vi.fn(async () => {});
    render(<Composer sending={false} onSend={onSend} whatsapp={{ available: true }} />);
    fireEvent.click(screen.getByLabelText('Enviar também por WhatsApp'));
    pick(file('a.pdf'), file('b.pdf'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Segue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByRole('alert').textContent).toBe('Pelo WhatsApp vai um anexo por mensagem. Envie os arquivos um a um ou desmarque o WhatsApp.');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remover b.pdf' }));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByRole('alert').textContent).toBe('Para enviar por WhatsApp, escreva a mensagem.');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Segue a guia' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const [text, viaWhatsApp, files] = onSend.mock.calls[0] as unknown as [string, boolean, File[]];
    expect([text, viaWhatsApp, files.length]).toEqual(['Segue a guia', true, 1]);
  });

  it('se o envio falha, o texto e os arquivos continuam na caixa', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('falhou');
    });
    render(<Composer sending={false} onSend={onSend} />);
    pick(file('a.pdf'));
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'Oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(chosen()).toEqual(['a.pdf1 KB']);
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).value).toBe('Oi');
  });
});

describe('ChatThread: anexos das mensagens', () => {
  const entries: ChatEntry[] = [
    { id: 'm1', mine: false, body: 'Segue o informe', createdAt: '2026-11-10T12:00:00Z', meta: 'Maria · 09:00', attachments: [{ fileId: 'f1', filename: 'informe.pdf', mimeType: 'application/pdf', size: 20_480 }] },
    {
      id: 'm2',
      mine: true,
      body: '',
      createdAt: '2026-11-10T12:05:00Z',
      meta: 'Ana · 09:05',
      attachments: [
        { fileId: 'f2', filename: 'guia.pdf', mimeType: 'application/pdf', size: 1024 },
        { fileId: 'f3', filename: 'foto.png', mimeType: 'image/png', size: 2 * 1024 * 1024 },
      ],
    },
    { id: 'm3', mine: true, body: 'Sem anexo', createdAt: '2026-11-10T12:06:00Z', meta: 'Ana · 09:06' },
  ];

  it('mostra cada anexo como link de download e baixa pelo callback de quem usa o chat', async () => {
    const onDownload = vi.fn(async () => {});
    render(<ChatThread entries={entries} empty="Nada" onDownload={onDownload} />);
    expect(screen.getAllByRole('list', { name: 'Anexos' })).toHaveLength(2);
    const links = screen.getAllByRole('button', { name: /^Baixar / });
    expect(links.map((b) => b.getAttribute('aria-label'))).toEqual(['Baixar informe.pdf (20 KB)', 'Baixar guia.pdf (1 KB)', 'Baixar foto.png (2,0 MB)']);

    fireEvent.click(screen.getByRole('button', { name: 'Baixar foto.png (2,0 MB)' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    const [entry, attachment] = onDownload.mock.calls[0] as unknown as [ChatEntry, { fileId: string }];
    expect([entry.id, attachment.fileId]).toEqual(['m2', 'f3']);
    // terminado o download, o link volta a responder
    await waitFor(() => expect((screen.getByRole('button', { name: 'Baixar foto.png (2,0 MB)' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('um download que falha não quebra a conversa', async () => {
    const onDownload = vi.fn(async () => {
      throw new Error('sem rede');
    });
    render(<ChatThread entries={entries} empty="Nada" onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Baixar informe.pdf (20 KB)' }));
    await waitFor(() => expect(onDownload).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Baixar informe.pdf (20 KB)' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Segue o informe')).toBeTruthy();
  });
});
