import { describe, expect, it } from 'vitest';
import { ADMIN_TABS } from './modules';
import { NAV, tabsPerms } from './nav';

describe('menu lateral (INT-17)', () => {
  it('Administração usa a união das permissões das abas registradas pelos módulos', () => {
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

  it('Elaboração aparece para quem lista, exporta ou processa', () => {
    expect(NAV.find((g) => g.id === 'elaboracao')!.perms).toEqual(['elaboration.export', 'elaboration.process', 'pre_declaration.view']);
  });
});
