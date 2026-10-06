/**
 * Modelos .xlsx de cada importação. A primeira aba é a que será lida de volta;
 * as demais trazem listas de apoio (colaboradores, grupos, procuradores) e as instruções.
 */
import { and, asc, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { IMPORT_KINDS, IMPORT_MAX_ROWS, PROCURATION_STATUS, formatCpfCnpj, formatPhone, type ImportKind } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { customerGroups, customers, procurators, users } from '../../db/schema';
import { customerScope } from '../../services/customers';
import { buildWorkbook, type SheetColumn } from '../../services/xlsx';

type Sheet = { name: string; columns: SheetColumn[]; rows: Record<string, unknown>[] };

const yesNo = (v: unknown) => (v ? 'Sim' : 'Não');

function instructions(kind: ImportKind): Sheet {
  const def = IMPORT_KINDS[kind];
  const rows: Record<string, unknown>[] = [
    ...def.required.map((c) => ({ col: c, req: 'Sim', note: '' })),
    ...def.optional.map((c) => ({ col: c, req: 'Não', note: '' })),
    { col: '', req: '', note: '' },
    ...def.tips.map((t) => ({ col: 'Orientação', req: '', note: t })),
    { col: 'Orientação', req: '', note: `Linhas idênticas repetidas são recusadas. O limite é de ${IMPORT_MAX_ROWS.toLocaleString('pt-BR')} linhas por arquivo.` },
    { col: 'Orientação', req: '', note: 'Não renomeie as colunas da primeira aba. Formatos aceitos: .xlsx e .csv.' },
  ];
  return {
    name: 'Instruções',
    columns: [
      { header: 'Coluna', key: 'col', width: 28 },
      { header: 'Obrigatória', key: 'req', width: 14 },
      { header: 'Orientação', key: 'note', width: 110 },
    ],
    rows,
  };
}

async function scopedCustomers(ctx: AppContext, user: AuthUser) {
  return ctx.db
    .select()
    .from(customers)
    .where(await customerScope(ctx, user))
    .orderBy(asc(customers.name));
}

/** Monta as abas do modelo (com os clientes do escritório quando o tipo é pré-preenchido). */
async function sheetsFor(ctx: AppContext, user: AuthUser, kind: ImportKind): Promise<{ sheets: Sheet[]; textColumns: string[] }> {
  const { db } = ctx;
  switch (kind) {
    case 'novos-clientes': {
      const team = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.officeId, user.officeId), eq(users.isActive, true)))
        .orderBy(asc(users.name));
      const groups = await db.select({ name: customerGroups.name }).from(customerGroups).where(eq(customerGroups.officeId, user.officeId)).orderBy(asc(customerGroups.name));
      return {
        textColumns: ['cpf', 'mobile', 'phone'],
        sheets: [
          {
            name: 'Clientes',
            columns: [
              { header: 'Nome', key: 'name', width: 36 },
              { header: 'CPF', key: 'cpf', width: 18 },
              { header: 'E-mail do responsável', key: 'responsible', width: 32 },
              { header: 'E-mail', key: 'email', width: 32 },
              { header: 'Celular', key: 'mobile', width: 18 },
              { header: 'Telefone', key: 'phone', width: 18 },
              { header: 'Grupo', key: 'group', width: 22 },
              { header: 'Data de nascimento', key: 'birth', width: 20 },
            ],
            rows: [],
          },
          {
            name: 'Colaboradores',
            columns: [
              { header: 'Nome', key: 'name', width: 32 },
              { header: 'E-mail (use na coluna do responsável)', key: 'email', width: 40 },
            ],
            rows: team,
          },
          { name: 'Grupos', columns: [{ header: 'Nome do grupo', key: 'name', width: 32 }], rows: groups },
          instructions(kind),
        ],
      };
    }
    case 'atualizar-clientes': {
      const list = await scopedCustomers(ctx, user);
      return {
        textColumns: ['cpf', 'mobile', 'phone'],
        sheets: [
          {
            name: 'Clientes',
            columns: [
              { header: 'Nome', key: 'name', width: 36 },
              { header: 'CPF', key: 'cpf', width: 20 },
              { header: 'E-mail', key: 'email', width: 32 },
              { header: 'Celular', key: 'mobile', width: 18 },
              { header: 'Telefone', key: 'phone', width: 18 },
            ],
            rows: list.map((c) => ({ name: c.name, cpf: formatCpfCnpj(c.cpfCnpj), email: c.email, mobile: formatPhone(c.mobile), phone: formatPhone(c.phone) })),
          },
          instructions(kind),
        ],
      };
    }
    case 'procuracoes': {
      const list = await scopedCustomers(ctx, user);
      const procs = await db.select().from(procurators).where(eq(procurators.officeId, user.officeId)).orderBy(asc(procurators.name));
      const docOf = new Map(procs.map((p) => [p.id, p.cpfCnpj]));
      return {
        textColumns: ['cpf', 'procurator'],
        sheets: [
          {
            name: 'Clientes',
            columns: [
              { header: 'Nome', key: 'name', width: 36 },
              { header: 'CPF', key: 'cpf', width: 20 },
              { header: 'CPF/CNPJ do procurador', key: 'procurator', width: 26 },
              { header: 'Situação da procuração', key: 'status', width: 26 },
            ],
            rows: list.map((c) => ({
              name: c.name,
              cpf: formatCpfCnpj(c.cpfCnpj),
              procurator: c.procuratorId ? formatCpfCnpj(docOf.get(c.procuratorId)) : '',
              status: PROCURATION_STATUS[c.procurationStatus as keyof typeof PROCURATION_STATUS] ?? c.procurationStatus,
            })),
          },
          {
            name: 'Procuradores',
            columns: [
              { header: 'Nome', key: 'name', width: 36 },
              { header: 'CPF/CNPJ', key: 'doc', width: 24 },
            ],
            rows: procs.map((p) => ({ name: p.name, doc: formatCpfCnpj(p.cpfCnpj) })),
          },
          instructions(kind),
        ],
      };
    }
    case 'ecac': {
      const list = await scopedCustomers(ctx, user);
      return {
        textColumns: ['cpf', 'login', 'password'],
        sheets: [
          {
            name: 'Clientes',
            columns: [
              { header: 'Nome', key: 'name', width: 36 },
              { header: 'CPF', key: 'cpf', width: 20 },
              { header: 'Login', key: 'login', width: 20 },
              { header: 'Senha', key: 'password', width: 20 },
              { header: 'Credenciais já cadastradas', key: 'has', width: 28 },
            ],
            rows: list.map((c) => ({ name: c.name, cpf: formatCpfCnpj(c.cpfCnpj), login: '', password: '', has: yesNo(c.ecacLoginEnc && c.ecacPasswordEnc) })),
          },
          instructions(kind),
        ],
      };
    }
  }
}

/** Gera o .xlsx do modelo. Colunas de documento/telefone/senha ficam como texto para o Excel não cortar zeros. */
export async function buildTemplate(ctx: AppContext, user: AuthUser, kind: ImportKind): Promise<Buffer> {
  const { sheets, textColumns } = await sheetsFor(ctx, user, kind);
  const buf = await buildWorkbook(sheets);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  sheets[0].columns.forEach((c, i) => {
    if (textColumns.includes(c.key)) ws.getColumn(i + 1).numFmt = '@';
  });
  const instr = wb.getWorksheet('Instruções');
  if (instr) instr.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
