import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { Button, ConfirmDialog, Drawer, Menu, MenuItem, Modal, TOAST_DURATION_MS, ToastProvider, usePagination, usePrint, useToast } from './index';

/** Acessibilidade de diálogos e menus e avisos de erro que não somem sozinhos. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tab = (shift = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });
const key = (k: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key: k });

function ModalHarness({ withField = true }: { withField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <Modal open={open} title="Novo cliente" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Salvar</Button>}>
        {withField ? <input aria-label="Nome" /> : <p>Só texto</p>}
      </Modal>
    </>
  );
}

describe('Modal, Drawer e ConfirmDialog', () => {
  it('Modal: nome pelo título, foco inicial no primeiro campo, Tab preso, Esc fecha e o foco volta', () => {
    render(<ModalHarness />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Novo cliente' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { name: 'Novo cliente' }).id);
    // foco inicial: o primeiro campo do conteúdo (não o X do cabeçalho)
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));

    // ordem: [Fechar, Nome, Salvar]; do último, Tab volta ao primeiro; do primeiro, Shift+Tab vai ao último
    const close = screen.getByRole('button', { name: 'Fechar' });
    const save = screen.getByRole('button', { name: 'Salvar' });
    save.focus();
    tab();
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(save);
    // foco fora do diálogo (clique no fundo): Tab traz de volta para dentro
    opener.focus();
    tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    key('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Modal sem campos: o foco vai para o primeiro botão do rodapé', () => {
    render(<ModalHarness withField={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Salvar' }));
  });

  it('respeita o autoFocus de quem usa o Modal, e ao fechar o foco volta para quem abriu', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Editar cliente
          </button>
          <Modal open={open} title="Editar" onClose={() => setOpen(false)}>
            <input aria-label="Primeiro" />
            <input aria-label="Segundo" autoFocus />
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Editar cliente' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Segundo'));
    key('Escape');
    expect(document.activeElement).toBe(opener);
  });

  it('diálogo montado já aberto ({cond && <Modal open />}): o foco também volta', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Excluir
          </button>
          {open && <ConfirmDialog open title="Excluir cliente" message="Tem certeza?" onConfirm={() => {}} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Excluir' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Drawer: diálogo modal com nome, foco dentro e Esc', () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Filtros" onClose={onClose}>
        <label>
          <input type="checkbox" /> Ativos
        </label>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Filtros' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('checkbox'));
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ConfirmDialog: o foco começa em "Cancelar" (Enter não confirma uma exclusão sem querer)', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open danger title="Excluir clientes" message="Tem certeza?" confirmLabel="Excluir" onConfirm={onConfirm} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Excluir clientes' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }));
    // do último botão, Tab volta ao X do cabeçalho: o foco não sai do diálogo
    screen.getByRole('button', { name: 'Excluir' }).focus();
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fechar' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('diálogos empilhados: Esc fecha só o de cima', () => {
    const closeDrawer = vi.fn();
    const closeModal = vi.fn();
    render(
      <>
        <Drawer open title="Filtros" onClose={closeDrawer}>
          <button type="button">Dentro do drawer</button>
        </Drawer>
        <Modal open title="Confirmar" onClose={closeModal}>
          <button type="button">Dentro do modal</button>
        </Modal>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dentro do modal' }));
    key('Escape');
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});

describe('Menu', () => {
  const renderMenu = (onPick = vi.fn(), onDialogClose = vi.fn()) =>
    render(
      <Modal open title="Com menu" onClose={onDialogClose}>
        <Menu trigger={(toggle) => <Button onClick={toggle}>Ações</Button>}>
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), onPick('a'))}>Primeira</MenuItem>
              <MenuItem disabled>Indisponível</MenuItem>
              <MenuItem onClick={() => (close(), onPick('c'))}>Terceira</MenuItem>
            </>
          )}
        </Menu>
      </Modal>,
    );

  it('acionador com aria-haspopup/aria-expanded; setas percorrem os itens; Esc fecha só o menu e devolve o foco', () => {
    const onDialogClose = vi.fn();
    renderMenu(vi.fn(), onDialogClose);
    const trigger = screen.getByRole('button', { name: 'Ações' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // ↓ no acionador abre com o foco no primeiro item
    trigger.focus();
    key('ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('menu').id);
    const first = screen.getByRole('menuitem', { name: 'Primeira' });
    const third = screen.getByRole('menuitem', { name: 'Terceira' });
    expect(document.activeElement).toBe(first);

    // o item desabilitado é pulado; a navegação dá a volta
    key('ArrowDown');
    expect(document.activeElement).toBe(third);
    key('ArrowDown');
    expect(document.activeElement).toBe(first);
    key('ArrowUp');
    expect(document.activeElement).toBe(third);
    key('Home');
    expect(document.activeElement).toBe(first);
    key('End');
    expect(document.activeElement).toBe(third);

    // Esc fecha o menu, não o diálogo em volta
    key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    // com o menu fechado, Esc volta a fechar o diálogo
    key('Escape');
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('clique abre com o foco no primeiro item; escolher fecha e devolve o foco ao acionador; Tab fecha', () => {
    const onPick = vi.fn();
    renderMenu(onPick);
    const trigger = screen.getByRole('button', { name: 'Ações' });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Primeira' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Terceira' }));
    expect(onPick).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeTruthy();
    key('Tab');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clique fora fecha', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Toast', () => {
  function Buttons() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast.success('Cliente salvo.')}>
          ok
        </button>
        <button type="button" onClick={() => toast.error('Não foi possível salvar.')}>
          erro
        </button>
        <button type="button" onClick={() => toast.clear()}>
          limpar
        </button>
      </>
    );
  }
  const renderToasts = () =>
    render(
      <ToastProvider>
        <Buttons />
      </ToastProvider>,
    );

  it('sucesso some sozinho; erro fica até ser dispensado', () => {
    vi.useFakeTimers();
    renderToasts();
    fireEvent.click(screen.getByText('ok'));
    fireEvent.click(screen.getByText('erro'));
    expect(screen.getByRole('status').textContent).toContain('Cliente salvo.');
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível salvar.');

    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS * 3));
    expect(screen.queryByText('Cliente salvo.')).toBeNull();
    expect(screen.getByText('Não foi possível salvar.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dispensar aviso' }));
    expect(screen.queryByText('Não foi possível salvar.')).toBeNull();
  });

  it('o mesmo erro repetido não empilha; clear() tira todos', () => {
    renderToasts();
    fireEvent.click(screen.getByText('erro'));
    fireEvent.click(screen.getByText('erro'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // o aviso de sucesso não tem botão de fechar (some sozinho)
    fireEvent.click(screen.getByText('ok'));
    expect(screen.getAllByRole('button', { name: 'Dispensar aviso' })).toHaveLength(1);
    fireEvent.click(screen.getByText('limpar'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('usePagination e usePrint', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i + 1);

  it('50 por página, última página parcial, volta à primeira quando a chave muda', () => {
    const { result, rerender } = renderHook(({ list, resetKey }) => usePagination(list, { resetKey }), { initialProps: { list: rows, resetKey: 'a' } });
    expect(result.current).toMatchObject({ page: 1, pages: 3, total: 120 });
    expect(result.current.rows).toHaveLength(50);
    act(() => result.current.setPage(3));
    expect(result.current.rows).toEqual(rows.slice(100));

    // a lista encolheu (filtro): a página atual não passa do fim
    rerender({ list: rows.slice(0, 60), resetKey: 'a' });
    expect(result.current).toMatchObject({ page: 2, pages: 2 });
    // outro relatório: primeira página
    rerender({ list: rows, resetKey: 'b' });
    expect(result.current.page).toBe(1);
    expect(result.current.rows[0]).toBe(1);
  });

  it('`all` devolve a lista inteira sem perder a página (impressão)', () => {
    const { result, rerender } = renderHook(({ all }) => usePagination(rows, { all, pageSize: 25 }), { initialProps: { all: false } });
    act(() => result.current.setPage(2));
    rerender({ all: true });
    expect(result.current.rows).toHaveLength(120);
    rerender({ all: false });
    expect(result.current.rows[0]).toBe(26);
  });

  it('lista vazia tem uma página', () => {
    const { result } = renderHook(() => usePagination([] as number[]));
    expect(result.current).toMatchObject({ page: 1, pages: 1, total: 0, rows: [] });
  });

  it('usePrint: a tela já está em modo de impressão quando o navegador abre o diálogo, e volta depois', () => {
    const seen: boolean[] = [];
    let current = false;
    const print = vi.fn(() => seen.push(current));
    vi.stubGlobal('print', print);
    const { result } = renderHook(() => {
      const p = usePrint();
      current = p.printing;
      return p;
    });
    expect(result.current.printing).toBe(false);
    act(() => result.current.print());
    expect(print).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true]);
    act(() => void window.dispatchEvent(new Event('afterprint')));
    expect(result.current.printing).toBe(false);
    // Ctrl+P: o navegador avisa antes de montar a impressão
    act(() => void window.dispatchEvent(new Event('beforeprint')));
    expect(result.current.printing).toBe(true);
    vi.unstubAllGlobals();
  });
});
