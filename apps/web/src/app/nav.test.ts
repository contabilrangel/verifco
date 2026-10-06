import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, DASHBOARD_PERMISSIONS, ELABORATION_LIST_PERMISSIONS, KANBAN_PERMISSIONS } from '@verifco/shared';
import { ADMIN_TABS } from './modules';
import { NAV, firstNavPath, tabsPerms, visibleNav, type Can, type NavGroup } from './nav';

/** `can` de um usuário com estas permissões (como o `useAuth().can`: basta uma). */
const user = (...perms: string[]): Can => (...p) => p.some((x) => perms.includes(x));
const owner: Can = () => true;
/** Destinos do menu visível, na ordem do menu. */
const paths = (nav: NavGroup[]) => nav.flatMap((g) => (g.to ? [g.to] : (g.children ?? []).map((c) => c.to)));
const inicio = (can: Can) => visibleNav(can).find((g) => g.id === 'inicio')?.children?.map((c) => c.to) ?? [];

describe('menu lateral (INT-17)', () => {
  it('Meu escritório usa a união das permissões das abas registradas pelos módulos', () => {
    const admin = NAV.find((g) => g.id === 'admin')!;
    const fromTabs = new Set(ADMIN_TABS.flatMap((t) => t.perms ?? []));
    expect(new Set(admin.perms)).toEqual(fromTabs);
    // abas de outros módulos entram sem editar o menu
    for (const perm of ['ecac.robot', 'ecac.sync', 'settings.edit', 'customer_group.create', 'customer_group.edit', 'customer_group.delete', 'integrations.manage', 'copilot.manage']) {
      expect(admin.perms, perm).toContain(perm);
    }
  });

  it('aba sem permissão deixa a página para todos; sem repetir chaves', () => {
    expect(tabsPerms([{ perms: ['a'] }, { perms: ['b', 'a'] }])).toEqual(['a', 'b']);
    expect(tabsPerms([{ perms: ['a'] }, { perms: [] }])).toEqual([]);
    expect(tabsPerms([{ perms: ['a'] }, {}])).toEqual([]);
  });

  it('Elaboração aparece para quem lista, exporta, processa, cria ou edita a pré-declaração (as mesmas da API)', () => {
    const perms = NAV.find((g) => g.id === 'elaboracao')!.perms;
    expect(perms).toEqual(['elaboration.export', 'elaboration.process', 'pre_declaration.view', 'pre_declaration.create', 'pre_declaration.edit']);
    // a lista é a mesma que a API usa no guard da listagem
    expect(perms).toBe(ELABORATION_LIST_PERMISSIONS);
  });

  it('Dashboard e Kanban usam as mesmas listas que a API confere em GET /dashboard e GET /kanban', () => {
    const items = NAV.find((g) => g.id === 'inicio')!.children!;
    expect(items.find((c) => c.to === '/')!.perms).toBe(DASHBOARD_PERMISSIONS);
    expect(items.find((c) => c.to === '/kanban')!.perms).toBe(KANBAN_PERMISSIONS);
    expect(DASHBOARD_PERMISSIONS).toEqual(['declaration.view', 'customer.list']);
    expect(KANBAN_PERMISSIONS).toEqual(['declaration.view']);
  });

  it('Dashboard e Kanban aparecem conforme a permissão', () => {
    expect(inicio(user('declaration.view'))).toEqual(['/', '/kanban']);
    expect(inicio(user('customer.list'))).toEqual(['/']);
    expect(inicio(user('radar.view'))).toEqual(['/radar']);
    expect(inicio(user('report.billing'))).toEqual([]);
    // grupo sem nenhum item visível some do menu
    expect(visibleNav(user('report.billing')).some((g) => g.id === 'inicio')).toBe(false);
    // cada permissão que não abre o dashboard nem o Kanban deixa os dois fora do menu
    for (const perm of ALL_PERMISSIONS.filter((k) => !DASHBOARD_PERMISSIONS.includes(k))) {
      expect(inicio(user(perm)), perm).not.toContain('/');
      expect(inicio(user(perm)), perm).not.toContain('/kanban');
    }
  });

  it('dono e quem tem todas as permissões veem o menu inteiro', () => {
    expect(paths(visibleNav(owner))).toEqual(paths(NAV));
    expect(paths(visibleNav(user(...ALL_PERMISSIONS)))).toEqual(paths(NAV));
    expect(firstNavPath(owner)).toBe('/');
  });

  it('página inicial: o primeiro destino do menu que o usuário vê', () => {
    expect(firstNavPath(user('declaration.view'))).toBe('/');
    expect(firstNavPath(user('customer.list'))).toBe('/');
    expect(firstNavPath(user('radar.view'))).toBe('/radar');
    expect(firstNavPath(user('report.billing'))).toBe('/relatorios/faturamento');
    expect(firstNavPath(user('backup.download'))).toBe('/backup');
    // sem o dashboard no menu, o destino nunca é "/" nem o Kanban (não há laço de redirecionamento)
    for (const perm of ALL_PERMISSIONS.filter((k) => !DASHBOARD_PERMISSIONS.includes(k))) {
      expect(firstNavPath(user(perm)), perm).not.toBe('/');
      expect(firstNavPath(user(perm)), perm).not.toBe('/kanban');
    }
    // menu sem nenhum destino liberado
    const restricted: NavGroup[] = [{ id: 'x', label: 'X', icon: NAV[0].icon, children: [{ to: '/x', label: 'X', perms: ['report.refund'] }] }];
    expect(firstNavPath(user('report.billing'), restricted)).toBeNull();
    expect(firstNavPath(user('report.refund'), restricted)).toBe('/x');
  });
});
