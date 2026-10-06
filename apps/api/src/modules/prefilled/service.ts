import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context';
import { files, prefilledStatements } from '../../db/schema';
import { sha256 } from '../../lib/crypto';
import type { CustomerRow } from '../../services/customers';
import type { UploadedFile } from '../../services/uploads';

export type PrefilledRow = typeof prefilledStatements.$inferSelect;

/*
 * De onde vêm as pré-preenchidas (COB-2). O Verifco não busca o arquivo no eCAC por conta própria:
 * - SERPRO Integra Contador: o catálogo de serviços não tem pré-preenchida; a sincronização do
 *   eCAC (`modules/ecac/jobs.ts`) consulta só procuração, caixa postal, situação fiscal e
 *   pagamentos. Se um serviço for publicado, a busca entra lá e grava por `savePrefilled`.
 * - Extensão do navegador: não há leitor da página "Declaração pré-preenchida" do eCAC (veja o
 *   comentário em apps/extension/content/parsers.js).
 * - Sincronizador: envia os arquivos que o contador baixa no eCAC e salva na pasta de
 *   pré-preenchidas (`--pasta-pre`), com o cliente identificado pelo CPF no nome do arquivo
 *   (POST /api/sync/prefilled, com token de escopo Sincronizador ou Extensão do navegador).
 * - Envio manual na tela Pré-preenchidas (POST /api/prefilled/upload).
 */

/**
 * Guarda o arquivo da declaração pré-preenchida de um cliente/exercício.
 * O mesmo conteúdo (hash) para o mesmo cliente e ano não é duplicado.
 */
export async function savePrefilled(
  ctx: AppContext,
  input: { officeId: string; customer: CustomerRow; year: number; file: UploadedFile; userId?: string | null },
): Promise<{ statement: PrefilledRow; duplicate: boolean }> {
  const { db } = ctx;
  const hash = sha256(input.file.data);
  const [dup] = await db
    .select({ p: prefilledStatements })
    .from(prefilledStatements)
    .innerJoin(files, eq(files.id, prefilledStatements.fileId))
    .where(and(eq(prefilledStatements.customerId, input.customer.id), eq(prefilledStatements.exerciseYear, input.year), eq(files.sha256, hash)))
    .limit(1);
  if (dup) return { statement: dup.p, duplicate: true };
  const saved = await ctx.files.save({
    officeId: input.officeId,
    data: input.file.data,
    filename: input.file.filename,
    mimeType: input.file.mimeType,
    userId: input.userId ?? null,
  });
  const [statement] = await db
    .insert(prefilledStatements)
    .values({ officeId: input.officeId, customerId: input.customer.id, exerciseYear: input.year, fileId: saved.id })
    .returning();
  return { statement, duplicate: false };
}
