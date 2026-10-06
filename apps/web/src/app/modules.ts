import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import type { LucideIcon } from 'lucide-react';

/** Aba do perfil do cliente; `path` é relativo a /clientes/:id ('' = aba inicial). */
export interface ProfileTab {
  path: string;
  label: string;
  icon: LucideIcon;
  element: ComponentType;
  perms?: string[];
  badge?: string;
  /** Ordem na barra de abas (menor primeiro). */
  order: number;
}

/** Aba de uma página com abas (Administração, Relatórios) ou etapa da aba IRPF. */
export interface SubTab {
  path: string;
  label: string;
  element: ComponentType;
  icon?: LucideIcon;
  perms?: string[];
  order: number;
}

/**
 * Contrato de um módulo do frontend. Cada pasta `modules/<nome>/module.tsx`
 * exporta `module` e é carregada automaticamente.
 */
export interface VerifcoModule {
  /** Rotas autenticadas, dentro do Shell (caminhos sem a barra inicial). */
  routes?: RouteObject[];
  /** Rotas públicas, fora do Shell (ex.: portal do cliente). */
  publicRoutes?: RouteObject[];
  /** Abas do perfil do cliente. */
  profileTabs?: ProfileTab[];
  /** Abas de /admin/<path>. */
  adminTabs?: SubTab[];
  /** Abas de /relatorios/<path>. */
  reportTabs?: SubTab[];
  /** Etapas da aba IRPF do cliente (/clientes/:id/irpf/<path>). */
  irpfSteps?: SubTab[];
}

const found = import.meta.glob<{ module: VerifcoModule }>('../modules/*/module.tsx', { eager: true });
const modules = Object.keys(found)
  .sort()
  .map((k) => found[k].module)
  .filter(Boolean);

const byOrder = <T extends { order: number }>(list: T[]) => list.sort((a, b) => a.order - b.order);

export const MODULE_ROUTES: RouteObject[] = modules.flatMap((m) => m.routes ?? []);
export const MODULE_PUBLIC_ROUTES: RouteObject[] = modules.flatMap((m) => m.publicRoutes ?? []);
export const PROFILE_TABS: ProfileTab[] = byOrder(modules.flatMap((m) => m.profileTabs ?? []));
export const ADMIN_TABS: SubTab[] = byOrder(modules.flatMap((m) => m.adminTabs ?? []));
export const REPORT_TABS: SubTab[] = byOrder(modules.flatMap((m) => m.reportTabs ?? []));
export const IRPF_STEPS: SubTab[] = byOrder(modules.flatMap((m) => m.irpfSteps ?? []));
