import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Building2,
  Download,
  FileStack,
  FileText,
  HardDriveDownload,
  Home,
  Mail,
  Receipt,
  Users,
  Wand2,
} from 'lucide-react';
import { ELABORATION_LIST_PERMISSIONS } from '@verifco/shared';
import { ADMIN_TABS, type SubTab } from './modules';

export interface NavLink {
  to: string;
  label: string;
  /** Exibe o link se o usuário tiver ao menos uma destas permissões (vazio = todos). */
  perms?: string[];
  end?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  to?: string;
  perms?: string[];
  children?: NavLink[];
}

/**
 * Permissões que mostram uma página com abas: a união das permissões das abas registradas pelos
 * módulos (vazio, para todos, se alguma aba não exige permissão).
 */
export function tabsPerms(tabs: Pick<SubTab, 'perms'>[]): string[] {
  if (tabs.some((t) => !t.perms?.length)) return [];
  return [...new Set(tabs.flatMap((t) => t.perms ?? []))];
}

export const NAV: NavGroup[] = [
  {
    id: 'inicio',
    label: 'Início',
    icon: Home,
    children: [
      { to: '/', label: 'Dashboard', end: true },
      { to: '/kanban', label: 'Kanban' },
      { to: '/radar', label: 'Radar de oportunidades', perms: ['radar.view'] },
    ],
  },
  {
    id: 'clientes',
    label: 'Clientes',
    icon: Users,
    children: [
      { to: '/clientes', label: 'Listar clientes', perms: ['customer.list'], end: true },
      { to: '/importacoes/novos-clientes', label: 'Novos clientes em lote', perms: ['worksheet.new_customers'] },
      { to: '/importacoes/atualizar-clientes', label: 'Atualizar clientes em lote', perms: ['worksheet.update_customers'] },
      { to: '/importacoes/procuracoes', label: 'Procuração em lote', perms: ['worksheet.procuration'] },
      { to: '/importacoes/ecac', label: 'Login eCAC em lote', perms: ['worksheet.ecac'] },
    ],
  },
  {
    id: 'financeiro',
    label: 'Financeiro',
    icon: Receipt,
    children: [
      { to: '/financeiro/metodos', label: 'Métodos de pagamento', perms: ['payment_method.list'] },
      { to: '/financeiro/tabelas', label: 'Tabelas de cobrança', perms: ['price_table.list'] },
      { to: '/importacoes/orcamentos', label: 'Orçamentos em lote', perms: ['worksheet.budget'] },
      { to: '/relatorios/faturamento', label: 'Faturamento', perms: ['report.billing'] },
    ],
  },
  {
    id: 'comunicacao',
    label: 'Comunicação',
    icon: Mail,
    children: [
      { to: '/comunicacao/mala-direta', label: 'Mala direta', perms: ['mailing.send_marketing', 'mailing.send_monthly', 'mailing.send_checklist_digital', 'mailing.send_checklist_pdf', 'mailing.send_planning', 'mailing.send_budget', 'post_declaration.send_kit'] },
      { to: '/comunicacao/templates', label: 'Templates de e-mail', perms: ['email_template.list'] },
      { to: '/comunicacao/envios', label: 'E-mails enviados', perms: ['mailing.list'] },
    ],
  },
  { id: 'relatorios', label: 'Relatórios', icon: BarChart3, to: '/relatorios', perms: ['report.billing', 'report.results', 'report.backlogs', 'report.refund'] },
  // as mesmas permissões que abrem a listagem da elaboração na API (LIST_PERMS em elaboration/routes.ts)
  { id: 'elaboracao', label: 'Elaboração', icon: Wand2, to: '/elaboracao', perms: ELABORATION_LIST_PERMISSIONS },
  { id: 'pre-preenchidas', label: 'Pré-preenchidas', icon: FileStack, to: '/pre-preenchidas', perms: ['prefilled.download'] },
  {
    id: 'admin',
    label: 'Meu escritório',
    icon: Building2,
    to: '/admin',
    // calculada das abas que os módulos registram; getter porque os módulos importam o Shell (que importa
    // este arquivo): a lista só é lida na renderização, com todos os módulos já carregados
    get perms() {
      return tabsPerms(ADMIN_TABS);
    },
  },
  { id: 'backup', label: 'Backup', icon: HardDriveDownload, to: '/backup', perms: ['backup.download'] },
  { id: 'downloads', label: 'Central de downloads', icon: Download, to: '/downloads' },
];

export const DOC_ICON = FileText;
