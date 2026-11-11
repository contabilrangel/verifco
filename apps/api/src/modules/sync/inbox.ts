/**
 * Caixa de entrada do robô: arquivos que o sincronizador encontrou e não conseguiu ligar a um
 * cliente (nome fora do padrão do programa IRPF ou CPF ainda não cadastrado). Ficam guardados até
 * alguém do escritório atribuir a um cliente (o arquivo entra como qualquer outro do sincronizador)
 * ou descartar.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { exerciseYearFromPath, isValidCpfCnpj, onlyDigits, parseIrpfFileName, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import { customers, files, reminderMarks, syncInbox } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import { badRequest } from '../../lib/errors';
import { notify } from '../../services/notify';
import type { UploadedFile } from '../../services/uploads';
import type { MachineAuth } from './tokens';

export const INBOX_REASONS = { sem_cpf: 'CPF não identificado no arquivo', cliente_nao_cadastrado: 'CPF sem cliente cadastrado' } as const;
export type InboxReason = keyof typeof INBOX_REASONS;

export type InboxRow = typeof syncInbox.$inferSelect;

/** Guarda o arquivo na caixa de entrada; o mesmo conteúdo não entra duas vezes. */
export async function receiveInboxFile(ctx: AppContext, auth: MachineAuth, file: UploadedFile, fields: Record<string, string>) {
  const { db } = ctx;
  const reason = (fields.motivo ?? '') as InboxReason;
  if (!(reason in INBOX_REASONS)) throw badRequest(`Motivo inválido: use ${Object.keys(INBOX_REASONS).join(' ou ')}.`);
  const hash = sha256(file.data);
  const existing = await db.query.syncInbox.findFirst({ where: and(eq(syncInbox.officeId, auth.officeId), eq(syncInbox.sha256, hash)) });
  if (existing) return { id: existing.id, duplicate: true };

  const info = parseIrpfFileName(file.filename);
  const sentCpf = onlyDigits(fields.cpf);
  // "sem_cpf" sem CPF informado inclui o caso em que o nome diz um CPF e o conteúdo diz outro:
  // ali o CPF do nome não é confiável, então não vira sugestão de cliente.
  const cpf = sentCpf && isValidCpfCnpj(sentCpf) ? sentCpf : reason === 'cliente_nao_cadastrado' ? info.cpf : null;
  const sentYear = Number(fields.ano);
  const year = Number.isInteger(sentYear) && sentYear >= 2000 && sentYear <= 2100 ? sentYear : (info.exerciseYear ?? exerciseYearFromPath(fields.caminho ?? '') ?? null);
  const saved = await ctx.files.save({ officeId: auth.officeId, data: file.data, filename: file.filename, mimeType: file.mimeType });
  const [row] = await db
    .insert(syncInbox)
    .values({
      officeId: auth.officeId,
      fileId: saved.id,
      filename: file.filename.slice(0, 255),
      originalPath: fields.caminho ? fields.caminho.slice(0, 500) : null,
      reason,
      cpf: cpf ?? null,
      exerciseYear: year,
      sha256: hash,
      tokenName: auth.name,
    })
    .onConflictDoNothing({ target: [syncInbox.officeId, syncInbox.sha256] })
    .returning();
  if (!row) {
    // outra requisição gravou o mesmo arquivo ao mesmo tempo
    await ctx.files.remove(auth.officeId, saved.id);
    const other = await db.query.syncInbox.findFirst({ where: and(eq(syncInbox.officeId, auth.officeId), eq(syncInbox.sha256, hash)) });
    return { id: other!.id, duplicate: true };
  }
  // um aviso por dia no sino basta: a lista fica em Meu escritório › Robô
  const [mark] = await db.insert(reminderMarks).values({ officeId: auth.officeId, key: `sync-inbox:${todayIso()}` }).onConflictDoNothing().returning();
  if (mark) {
    await notify(db, {
      officeId: auth.officeId,
      title: 'Sincronizador: arquivos sem cliente',
      body: 'O sincronizador encontrou arquivos que não conseguiu ligar a um cliente. Atribua cada um a um cliente ou descarte.',
      link: '/admin/robo',
    });
  }
  return { id: row.id, duplicate: false };
}

/** Itens pendentes com o cliente sugerido quando o CPF do arquivo já está cadastrado. */
export async function listInbox(ctx: AppContext, officeId: string) {
  const { db } = ctx;
  const rows = await db
    .select({ item: syncInbox, size: files.size })
    .from(syncInbox)
    .innerJoin(files, eq(files.id, syncInbox.fileId))
    .where(and(eq(syncInbox.officeId, officeId), eq(syncInbox.status, 'pending')))
    .orderBy(desc(syncInbox.createdAt))
    .limit(200);
  const cpfs = [...new Set(rows.map((r) => r.item.cpf).filter((c): c is string => Boolean(c)))];
  const known = cpfs.length
    ? await db
        .select({ id: customers.id, name: customers.name, cpfCnpj: customers.cpfCnpj, deletedAt: customers.deletedAt })
        .from(customers)
        .where(and(eq(customers.officeId, officeId), inArray(customers.cpfCnpj, cpfs)))
    : [];
  const byCpf = new Map(known.filter((c) => !c.deletedAt).map((c) => [c.cpfCnpj, c]));
  return rows.map(({ item, size }) => {
    const suggested = item.cpf ? byCpf.get(item.cpf) : undefined;
    return {
      id: item.id,
      filename: item.filename,
      originalPath: item.originalPath,
      reason: item.reason,
      reasonLabel: INBOX_REASONS[item.reason as InboxReason] ?? item.reason,
      cpf: item.cpf,
      exerciseYear: item.exerciseYear,
      size,
      tokenName: item.tokenName,
      createdAt: item.createdAt,
      suggestedCustomer: suggested ? { id: suggested.id, name: suggested.name } : null,
    };
  });
}
