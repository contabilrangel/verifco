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
}

const found = import.meta.glob<{ module: VerifcoModule }>('../modules/*/module.tsx', { eager: true });
const modules = Object.keys(found)
  .sort()
  .map((k) => found[k].module)
  .filter(Boolean);

export const MODULE_ROUTES: RouteObject[] = modules.flatMap((m) => m.routes ?? []);
export const MODULE_PUBLIC_ROUTES: RouteObject[] = modules.flatMap((m) => m.publicRoutes ?? []);
export const PROFILE_TABS: ProfileTab[] = modules.flatMap((m) => m.profileTabs ?? []).sort((a, b) => a.order - b.order);
