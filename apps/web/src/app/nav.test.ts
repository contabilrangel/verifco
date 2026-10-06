import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '@verifco/shared';
import { ADMIN_TABS, REPORT_TABS, type SubTab } from './modules';
import { ADMIN_PERMS, ELABORATION_PERMS, NAV, REPORT_PERMS } from './nav';

const tabPerms = (tabs: SubTab[]) => [...new Set(tabs.flatMap((t) => t.perms ?? []))].sort();

// INT-17: o menu abre os grupos com abas para quem tem a permissão de qualquer aba registrada
describe('menu lateral × permissões', () => {
  it('Administração abre para a permissão de qualquer aba de /admin (inclui Robô, Preferências e Grupos)', () => {
    expect([...ADMIN_PERMS].sort()).toEqual(tabPerms(ADMIN_TABS));
    expect(ADMIN_PERMS).toEqual(expect.arrayContaining(['ecac.robot', 'ecac.sync', 'settings.edit', 'customer_group.create', 'customer_group.edit', 'customer_group.delete']));
  });

  it('Relatórios abre para a permissão de qualquer aba de /relatorios', () => {
    expect([...REPORT_PERMS].sort()).toEqual(tabPerms(REPORT_TABS));
  });

  it('Elaboração aceita quem só processa (as mesmas permissões da listagem na API)', () => {
    expect(ELABORATION_PERMS).toEqual(expect.arrayContaining(['elaboration.process', 'elaboration.export', 'pre_declaration.view']));
    expect(NAV.find((g) => g.id === 'elaboracao')?.perms).toBe(ELABORATION_PERMS);
  });

  it('todas as permissões do menu existem no catálogo', () => {
    const all = NAV.flatMap((g) => [...(g.perms ?? []), ...(g.children ?? []).flatMap((c) => c.perms ?? [])]);
    for (const p of all) expect(ALL_PERMISSIONS).toContain(p);
  });
});
