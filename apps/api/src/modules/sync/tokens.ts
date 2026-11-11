import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { MACHINE_TOKEN_PREFIX, type MachineTokenScope } from '@verifco/shared';
import type { AppContext } from '../../context';
import { apiTokens } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';
import { HttpError, forbidden } from '../../lib/errors';
import { parseClientHeader } from './packages';

export type ApiTokenRow = typeof apiTokens.$inferSelect;

/** Token autenticado numa requisição de máquina (extensão ou sincronizador). */
export interface MachineAuth {
  tokenId: string;
  officeId: string;
  scope: MachineTokenScope;
  name: string;
  /** Versão informada pelo programa (cabeçalho `X-Verifco-Client`); null nas versões antigas. */
  clientVersion: string | null;
}

/** Gera um token novo: `vfk_` + 32 bytes aleatórios em base64url. Só o hash vai para o banco. */
export function generateMachineToken() {
  const token = `${MACHINE_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256(token), prefix: token.slice(0, MACHINE_TOKEN_PREFIX.length + 4) };
}

/** Versão pública do token (sem o hash). */
export function publicToken(row: ApiTokenRow & { createdByName?: string | null }) {
  const { tokenHash, ...rest } = row;
  return { ...rest, active: !row.revokedAt };
}

const unauthorizedMachine = (msg = 'Token de máquina ausente ou inválido. Use "Authorization: Bearer vfk_...".') => new HttpError(401, msg);

/**
 * Autentica a requisição pelo token de máquina e confere o escopo.
 * 401 sem token, token desconhecido ou revogado; 403 quando o escopo não permite a rota.
 */
export async function requireMachine(ctx: AppContext, req: FastifyRequest, scopes: MachineTokenScope[]): Promise<MachineAuth> {
  const header = req.headers.authorization ?? '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw.startsWith(MACHINE_TOKEN_PREFIX) || raw.length < MACHINE_TOKEN_PREFIX.length + 20) throw unauthorizedMachine();
  const row = await ctx.db.query.apiTokens.findFirst({ where: and(eq(apiTokens.tokenHash, sha256(raw)), isNull(apiTokens.revokedAt)) });
  if (!row) throw unauthorizedMachine('Token de máquina inválido ou revogado.');
  if (!scopes.includes(row.scope as MachineTokenScope)) {
    throw forbidden(`Este token é do escopo "${row.scope}" e não permite esta operação.`);
  }
  // versão do programa: vale só a do mesmo tipo do token (a extensão não se passa por sincronizador)
  const client = parseClientHeader(req.headers['x-verifco-client']);
  const sameKind = client?.kind === row.scope ? client : null;
  const versionChanged = Boolean(sameKind) && (sameKind!.version !== row.clientVersion || sameKind!.platform !== row.clientPlatform);
  // registra o último uso (no máximo uma escrita por minuto por token; na hora quando a versão muda)
  if (versionChanged || !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await ctx.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(), lastUsedIp: req.ip ?? null, ...(sameKind ? { clientVersion: sameKind.version, clientPlatform: sameKind.platform } : {}) })
      .where(eq(apiTokens.id, row.id));
  }
  return { tokenId: row.id, officeId: row.officeId, scope: row.scope as MachineTokenScope, name: row.name, clientVersion: sameKind?.version ?? null };
}
