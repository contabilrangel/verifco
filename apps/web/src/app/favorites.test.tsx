import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { favoriteLabel, isInternalPath, visibleFavorites } from './favorites';
import { FavoritesNav } from './Shell';

describe('favoritos', () => {
  it('só aceita caminhos internos da aplicação', () => {
    expect(isInternalPath('/clientes?busca=ana')).toBe(true);
    expect(isInternalPath('/admin/colaboradores')).toBe(true);
    expect(isInternalPath('//outro-site.com')).toBe(false);
    expect(isInternalPath('/\\outro-site.com')).toBe(false);
    expect(isInternalPath('https://outro-site.com')).toBe(false);
    expect(isInternalPath('javascript:alert(1)')).toBe(false);
  });

  it('lista os favoritos válidos em ordem alfabética', () => {
    const list = visibleFavorites([
      { path: '/kanban', label: 'Kanban' },
      { path: '//x.com', label: 'Externo' },
      { path: '/admin/colaboradores', label: 'Administração › Colaboradores' },
    ]);
    expect(list.map((f) => f.label)).toEqual(['Administração › Colaboradores', 'Kanban']);
    expect(visibleFavorites(undefined)).toEqual([]);
  });

  it('nomeia o favorito com a aba aberta', () => {
    expect(favoriteLabel('Administração', 'Colaboradores')).toBe('Administração › Colaboradores');
    expect(favoriteLabel('Dashboard')).toBe('Dashboard');
    expect(favoriteLabel('Painel', 'Painel')).toBe('Painel');
    expect(favoriteLabel('x'.repeat(250)).length).toBe(200);
  });
});

describe('FavoritesNav (menu lateral)', () => {
  afterEach(cleanup);

  it('não mostra a seção sem favoritos', () => {
    const { container } = render(
      <MemoryRouter>
        <FavoritesNav favorites={[]} onRemove={() => {}} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('mostra os atalhos, marca a página aberta e permite remover', () => {
    const onRemove = vi.fn();
    const favorites = [
      { path: '/kanban', label: 'Kanban' },
      { path: '/clientes?busca=ana', label: 'Clientes' },
      { path: '//x.com', label: 'Externo' },
    ];
    render(
      <MemoryRouter initialEntries={['/clientes?busca=ana']}>
        <FavoritesNav favorites={favorites} onRemove={onRemove} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('group', { name: 'Favoritos' })).toBeTruthy();
    const kanban = screen.getByRole('link', { name: 'Kanban' });
    expect(kanban.getAttribute('href')).toBe('/kanban');
    expect(kanban.getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Clientes' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('link', { name: 'Externo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remover Kanban dos favoritos' }));
    expect(onRemove).toHaveBeenCalledWith({ path: '/kanban', label: 'Kanban' });
  });
});
