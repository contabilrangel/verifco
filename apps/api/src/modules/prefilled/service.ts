import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { files, prefilledStatements } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import type { CustomerRow } from '../../services/customers';
import { guessMimeType, type UploadedFile } from '../sync/multipart';

export type PrefilledRow = typeof prefilledStatements.$inferSelect;

/**
 * Guarda o arquivo da declaração pré-preenchida de um cliente/exercício.
 * O mesmo conteúdo (hash) para o mesmo cliente e ano não é duplicado.
 */
export async function savePrefilled(
  ctx: AppContext,
  input: { officeId: string; customer: CustomerRow; year: number; file: UploadedFile; userId?: string | null },
): Promise<{ statement: PrefilledRow; duplicate: boolean }> {
  const { db } = ctx;
  const hash = sha256(input.file.buffer);
  const [dup] = await db
    .select({ p: prefilledStatements })
    .from(prefilledStatements)
    .innerJoin(files, eq(files.id, prefilledStatements.fileId))
    .where(and(eq(prefilledStatements.customerId, input.customer.id), eq(prefilledStatements.exerciseYear, input.year), eq(files.sha256, hash)))
    .limit(1);
  if (dup) return { statement: dup.p, duplicate: true };
  const saved = await ctx.files.save({
    officeId: input.officeId,
    data: input.file.buffer,
    filename: input.file.filename,
    mimeType: guessMimeType(input.file.filename, input.file.mimeType),
    userId: input.userId ?? null,
  });
  const [statement] = await db
    .insert(prefilledStatements)
    .values({ officeId: input.officeId, customerId: input.customer.id, exerciseYear: input.year, fileId: saved.id })
    .returning();
  return { statement, duplicate: false };
}
