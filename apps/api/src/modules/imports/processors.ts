/**
 * Processamento linha a linha de cada tipo de importação.
 * Cada linha é validada e gravada de forma independente: um erro não impede as demais.
 * Linhas sem nada a importar (ex.: senha em branco no modelo pré-preenchido) ou sem
 * alteração são ignoradas e não entram no total do lote.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { formatCpfCnpj, isValidCpf, isValidCpfCnpj, isValidEmail, todayIso, utcDateIso, type ImportKind, type ImportRowResult } from '@verifco/shared';
import type { AppContext, AuthUser } from '../../context';
import { customerGroupMembers, customerGroups, customers, procurators, users } from '../../db/schema';
import { customerScope } from '../../services/customers';
import { parseDate } from '../../services/xlsx';
import { COLUMNS, normalizeDoc, normalizePhone, pick, rowSignature, type SheetRow } from './sheet';

export interface ProcessOutput {
  results: ImportRowResult[];
  ignored: number;
}

type RowOutcome = { ok: true; message: string } | { ok: false; message: string } | { ignored: true };

interface Runner {
  /** Valor que identifica o registro (CPF) para detectar repetição no arquivo. */
  key?: (values: Record<string, string>) => string | null;
  /** Linha sem dados a importar. */
  skip?: (values: Record<string, string>) => boolean;
  run: (row: SheetRow) => Promise<RowOutcome>;
}

/** Aplica as regras comuns (ignorar, linha idêntica, CPF repetido) e executa linha a linha. */
async function runRows(rows: SheetRow[], runner: Runner, log: (err: unknown) => void): Promise<ProcessOutput> {
  const results: ImportRowResult[] = [];
  let ignored = 0;
  const seenRows = new Map<string, number>();
  const seenKeys = new Map<string, number>();
  for (const row of rows) {
    if (runner.skip?.(row.values)) {
      ignored++;
      continue;
    }
    const sig = rowSignature(row.values);
    const twin = seenRows.get(sig);
    if (twin !== undefined) {
      results.push({ row: row.rowNumber, ok: false, message: `Linha repetida: igual à linha ${twin}.` });
      continue;
    }
    seenRows.set(sig, row.rowNumber);
    const key = runner.key?.(row.values);
    if (key) {
      const first = seenKeys.get(key);
      if (first !== undefined) {
        results.push({ row: row.rowNumber, ok: false, message: `CPF ${formatCpfCnpj(key)} repetido na planilha (já aparece na linha ${first}).` });
        continue;
      }
      seenKeys.set(key, row.rowNumber);
    }
    let outcome: RowOutcome;
    try {
      outcome = await runner.run(row);
    } catch (err) {
      log(err);
      const code = (err as { code?: string }).code;
      outcome = { ok: false, message: code === '23505' ? 'Registro já existe (duplicidade).' : 'Erro inesperado ao gravar esta linha. Tente novamente.' };
    }
    if ('ignored' in outcome) ignored++;
    else results.push({ row: row.rowNumber, ok: outcome.ok, message: outcome.message });
  }
  return { results, ignored };
}

const fail = (errors: string[]): RowOutcome => ({ ok: false, message: errors.join(' ') });

/** AAAA-MM-DD que existe no calendário (31/02 não passa). */
const isRealDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && utcDateIso(d) === iso;
};

/** CPF do cliente na linha: obrigatório e válido (aceita CNPJ quando `allowCnpj`). */
function readCustomerDoc(values: Record<string, string>, errors: string[], allowCnpj: boolean): string | null {
  const raw = pick(values, COLUMNS.cpf);
  if (!raw) {
    errors.push('Informe o CPF.');
    return null;
  }
  const doc = normalizeDoc(raw, allowCnpj);
  const valid = allowCnpj ? isValidCpfCnpj(doc) : isValidCpf(doc);
  if (!valid) {
    errors.push(`CPF ${raw} inválido.`);
    return null;
  }
  return doc;
}

function readContacts(values: Record<string, string>, errors: string[]) {
  const email = pick(values, COLUMNS.email).toLowerCase();
  if (email && !isValidEmail(email)) errors.push(`E-mail ${email} inválido.`);
  const mobileRaw = pick(values, COLUMNS.mobile);
  const mobile = mobileRaw ? normalizePhone(mobileRaw) : null;
  if (mobileRaw && !mobile) errors.push(`Celular ${mobileRaw} inválido (use DDD + número).`);
  const phoneRaw = pick(values, COLUMNS.phone);
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (phoneRaw && !phone) errors.push(`Telefone ${phoneRaw} inválido (use DDD + número).`);
  return { email: email || null, mobile, phone };
}

const docKey = (allowCnpj: boolean) => (values: Record<string, string>) => {
  const raw = pick(values, COLUMNS.cpf);
  if (!raw) return null;
  const d = normalizeDoc(raw, allowCnpj);
  return (allowCnpj ? isValidCpfCnpj(d) : isValidCpf(d)) ? d : null;
};

/** Clientes visíveis ao usuário, indexados pelo CPF/CNPJ. */
async function scopedCustomersByDoc(ctx: AppContext, user: AuthUser) {
  const rows = await ctx.db
    .select({
      id: customers.id,
      name: customers.name,
      cpfCnpj: customers.cpfCnpj,
      email: customers.email,
      mobile: customers.mobile,
      phone: customers.phone,
      procuratorId: customers.procuratorId,
    })
    .from(customers)
    .where(await customerScope(ctx, user));
  return new Map(rows.map((r) => [r.cpfCnpj, r]));
}

// ---------------------------------------------------------------- novos clientes
async function newCustomers(ctx: AppContext, user: AuthUser, rows: SheetRow[], log: (e: unknown) => void) {
  const { db } = ctx;
  // CPF é único por escritório (independe da restrição de visibilidade)
  const existing = new Set(
    (await db.select({ doc: customers.cpfCnpj }).from(customers).where(and(eq(customers.officeId, user.officeId), isNull(customers.deletedAt)))).map((r) => r.doc),
  );
  const team = new Map(
    (await db.select({ id: users.id, email: users.email, isActive: users.isActive }).from(users).where(eq(users.officeId, user.officeId))).map((u) => [u.email.toLowerCase(), u]),
  );
  const groups = new Map(
    (await db.select({ id: customerGroups.id, name: customerGroups.name }).from(customerGroups).where(eq(customerGroups.officeId, user.officeId))).map((g) => [
      g.name.trim().toLowerCase(),
      g.id,
    ]),
  );
  const today = todayIso();

  return runRows(
    rows,
    {
      key: docKey(false),
      run: async ({ values }) => {
        const errors: string[] = [];
        const name = pick(values, COLUMNS.name);
        if (name.length < 2) errors.push('Informe o nome do cliente.');
        else if (name.length > 200) errors.push('Nome com mais de 200 caracteres.');
        const doc = readCustomerDoc(values, errors, false);
        if (doc && existing.has(doc)) errors.push(`CPF ${formatCpfCnpj(doc)} já está cadastrado.`);

        const respEmail = pick(values, COLUMNS.responsible).toLowerCase();
        const responsible = respEmail ? team.get(respEmail) : undefined;
        if (!respEmail) errors.push('Informe o e-mail do responsável.');
        else if (!responsible) errors.push(`O responsável ${respEmail} não é colaborador do escritório.`);
        else if (!responsible.isActive) errors.push(`O responsável ${respEmail} está inativo.`);

        const contacts = readContacts(values, errors);

        const birthRaw = pick(values, COLUMNS.birthDate);
        const birthDate = birthRaw ? parseDate(birthRaw) : null;
        if (birthRaw && (!birthDate || !isRealDate(birthDate) || birthDate < '1900-01-01' || birthDate > today)) {
          errors.push(`Data de nascimento ${birthRaw} inválida (use DD/MM/AAAA).`);
        }

        const groupIds: string[] = [];
        const groupRaw = pick(values, COLUMNS.group);
        for (const g of groupRaw ? groupRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : []) {
          const id = groups.get(g.toLowerCase());
          if (id) groupIds.push(id);
          else errors.push(`Grupo “${g}” não existe.`);
        }

        if (errors.length || !doc || !responsible) return fail(errors);
        await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(customers)
            .values({
              officeId: user.officeId,
              name,
              cpfCnpj: doc,
              email: contacts.email,
              mobile: contacts.mobile,
              phone: contacts.phone,
              birthDate,
              responsibleUserId: responsible.id,
            })
            .returning({ id: customers.id });
          const unique = [...new Set(groupIds)];
          if (unique.length) await tx.insert(customerGroupMembers).values(unique.map((groupId) => ({ customerId: row.id, groupId })));
        });
        existing.add(doc);
        return { ok: true, message: `Cliente ${name} cadastrado.` };
      },
    },
    log,
  );
}

// ---------------------------------------------------------------- atualização de contatos
async function updateCustomers(ctx: AppContext, user: AuthUser, rows: SheetRow[], log: (e: unknown) => void) {
  const byDoc = await scopedCustomersByDoc(ctx, user);
  return runRows(
    rows,
    {
      key: docKey(true),
      skip: (v) => !pick(v, COLUMNS.email) && !pick(v, COLUMNS.mobile) && !pick(v, COLUMNS.phone),
      run: async ({ values }) => {
        const errors: string[] = [];
        const doc = readCustomerDoc(values, errors, true);
        const c = doc ? byDoc.get(doc) : undefined;
        if (doc && !c) errors.push(`Cliente com CPF ${formatCpfCnpj(doc)} não encontrado.`);
        const contacts = readContacts(values, errors);
        if (errors.length || !c) return fail(errors);

        // célula vazia mantém o valor atual
        const changes: Partial<{ email: string; mobile: string; phone: string }> = {};
        if (contacts.email && contacts.email !== (c.email ?? '').toLowerCase()) changes.email = contacts.email;
        if (contacts.mobile && contacts.mobile !== c.mobile) changes.mobile = contacts.mobile;
        if (contacts.phone && contacts.phone !== c.phone) changes.phone = contacts.phone;
        const fields = Object.keys(changes);
        if (!fields.length) return { ignored: true };
        await ctx.db
          .update(customers)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(customers.id, c.id));
        Object.assign(c, changes);
        const labels = { email: 'e-mail', mobile: 'celular', phone: 'telefone' } as const;
        return { ok: true, message: `${c.name}: ${fields.map((f) => labels[f as keyof typeof labels]).join(', ')} atualizado(s).` };
      },
    },
    log,
  );
}

// ---------------------------------------------------------------- procurações
async function procurations(ctx: AppContext, user: AuthUser, rows: SheetRow[], log: (e: unknown) => void) {
  const byDoc = await scopedCustomersByDoc(ctx, user);
  const procs = new Map(
    (await ctx.db.select({ id: procurators.id, name: procurators.name, doc: procurators.cpfCnpj }).from(procurators).where(eq(procurators.officeId, user.officeId))).map(
      (p) => [p.doc, p],
    ),
  );
  return runRows(
    rows,
    {
      key: docKey(true),
      skip: (v) => !pick(v, COLUMNS.procurator),
      run: async ({ values }) => {
        const errors: string[] = [];
        const doc = readCustomerDoc(values, errors, true);
        const c = doc ? byDoc.get(doc) : undefined;
        if (doc && !c) errors.push(`Cliente com CPF ${formatCpfCnpj(doc)} não encontrado.`);
        const procRaw = pick(values, COLUMNS.procurator);
        const procDoc = normalizeDoc(procRaw, true);
        const proc = procs.get(procDoc);
        if (!isValidCpfCnpj(procDoc)) errors.push(`CPF/CNPJ do procurador ${procRaw} inválido.`);
        else if (!proc) errors.push(`Procurador ${formatCpfCnpj(procDoc)} não está cadastrado em Administração › Procuradores.`);
        if (errors.length || !c || !proc) return fail(errors);
        if (c.procuratorId === proc.id) return { ignored: true };
        await ctx.db
          .update(customers)
          .set({ procuratorId: proc.id, procurationStatus: 'validating', updatedAt: new Date() })
          .where(eq(customers.id, c.id));
        c.procuratorId = proc.id;
        return { ok: true, message: `${c.name} associado ao procurador ${proc.name}; procuração aguardando validação.` };
      },
    },
    log,
  );
}

// ---------------------------------------------------------------- login eCAC
async function ecac(ctx: AppContext, user: AuthUser, rows: SheetRow[], log: (e: unknown) => void) {
  const byDoc = await scopedCustomersByDoc(ctx, user);
  return runRows(
    rows,
    {
      key: docKey(true),
      skip: (v) => !pick(v, COLUMNS.ecacPassword) && !pick(v, COLUMNS.ecacLogin),
      run: async ({ values }) => {
        const errors: string[] = [];
        const doc = readCustomerDoc(values, errors, true);
        const c = doc ? byDoc.get(doc) : undefined;
        if (doc && !c) errors.push(`Cliente com CPF ${formatCpfCnpj(doc)} não encontrado.`);
        const password = pick(values, COLUMNS.ecacPassword);
        const login = pick(values, COLUMNS.ecacLogin) || doc || '';
        if (!password) errors.push('Informe a senha.');
        if (password.length > 200 || login.length > 200) errors.push('Login ou senha com mais de 200 caracteres.');
        if (errors.length || !c) return fail(errors);
        await ctx.db
          .update(customers)
          .set({ ecacLoginEnc: ctx.secrets.encrypt(login), ecacPasswordEnc: ctx.secrets.encrypt(password), updatedAt: new Date() })
          .where(eq(customers.id, c.id));
        return { ok: true, message: `Credenciais eCAC de ${c.name} salvas.` };
      },
    },
    log,
  );
}

export const PROCESSORS: Record<ImportKind, (ctx: AppContext, user: AuthUser, rows: SheetRow[], log: (e: unknown) => void) => Promise<ProcessOutput>> = {
  'novos-clientes': newCustomers,
  'atualizar-clientes': updateCustomers,
  procuracoes: procurations,
  ecac,
};
