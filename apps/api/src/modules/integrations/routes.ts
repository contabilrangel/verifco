import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  INTEGRATION_CATALOG,
  INTEGRATION_PROVIDERS,
  getIntegrationDef,
  integrationDefaults,
  missingIntegrationFields,
  type IntegrationDef,
  type IntegrationField,
  type IntegrationProvider,
} from '@verifco/shared';
import type { AppContext } from '../../context';
import { integrations, procurators } from '../../db/schema';
import { randomToken } from '../../lib/crypto';
import { badRequest, notFound, forbidden } from '../../lib/errors';
import { audit, guard, parse, requireUser } from '../../lib/http';
import { SMTP_ALLOWED_PORTS } from '../../integrations/email';
import { IntegrationError, errorMessage } from '../../integrations/http';
import { isInternalHostname, unsafeBaseUrlReason } from '../../integrations/ssrf';
import { scheduleOmiePoll, type OmieConfig } from '../../integrations/omie';
import { clearSerproTokens } from '../../integrations/serpro';
import { decryptSecrets, getIntegrationRow, maskSecret, type IntegrationRow } from '../../integrations/store';
import { testIntegration } from '../../integrations/testers';
import { requeuePendingBillings } from './jobs';
import { cancelEcacDailySync, scheduleEcacDailySync } from '../ecac/jobs';

const PROVIDER_KEYS = Object.keys(INTEGRATION_PROVIDERS) as [IntegrationProvider, ...IntegrationProvider[]];
const providerParam = z.object({ provider: z.enum(PROVIDER_KEYS) });
/** Chaves da configuração pública mantidas pelo servidor (não editáveis). */
const SERVER_KEYS = new Set(['lastTestAt']);

const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function fieldSchema(f: IntegrationField): z.ZodType {
  switch (f.type) {
    case 'number':
      return z.coerce.number({ message: 'informe um número' }).int('informe um número inteiro').min(0).max(1e12);
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum((f.options ?? []).map((o) => o.value) as [string, ...string[]], { message: 'opção inválida' });
    case 'url':
      // a URL é chamada pelo servidor: só https público (proteção contra SSRF)
      return z
        .string()
        .trim()
        .max(500)
        .superRefine((v, ctx) => {
          const reason = unsafeBaseUrlReason(v);
          if (reason) ctx.addIssue({ code: 'custom', message: reason });
        });
    case 'email':
      return z.email('e-mail inválido').max(320);
    case 'procurator':
      return z.uuid('selecione um certificado');
    case 'textarea':
      return z.string().trim().max(5000, 'use no máximo 5.000 caracteres');
    default:
      return z.string().trim().max(500);
  }
}

/** Valida e normaliza os campos públicos enviados (ignora segredos e chaves desconhecidas). */
function parseConfig(def: IntegrationDef, input: Record<string, unknown>) {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const f of def.fields) {
    if (f.type === 'secret' || !(f.key in input)) continue;
    const raw = input[f.key];
    // '' é uma opção válida em alguns selects (ex.: "Padrão do Verifco")
    if (empty(raw) && !(f.type === 'select' && f.options?.some((o) => o.value === ''))) {
      unset.push(f.key);
      continue;
    }
    const r = fieldSchema(f).safeParse(typeof raw === 'string' ? raw.trim() : raw);
    const invalid = r.success && typeof r.data === 'string' ? f.validate?.(r.data) : null;
    if (invalid) errors.push({ path: `config.${f.key}`, message: `${f.label}: ${invalid}` });
    else if (r.success) set[f.key] = f.key === 'contractorCnpj' ? String(r.data).replace(/\D+/g, '') : r.data;
    else errors.push({ path: `config.${f.key}`, message: `${f.label}: ${r.error.issues[0]?.message ?? 'valor inválido'}` });
  }
  // SMTP do escritório: o servidor conecta nele, então nada de rede interna nem portas que não sejam de e-mail
  if (def.key === 'smtp') {
    if (typeof set.host === 'string' && (isInternalHostname(set.host) || /[/:@\s]/.test(set.host))) {
      errors.push({ path: 'config.host', message: 'Servidor SMTP: informe o nome público do servidor (endereços internos não são permitidos)' });
    }
    if (set.port !== undefined && !SMTP_ALLOWED_PORTS.includes(Number(set.port))) {
      errors.push({ path: 'config.port', message: `Porta: use ${SMTP_ALLOWED_PORTS.join(', ')}` });
    }
  }
  if (errors.length) throw badRequest('Dados inválidos: ' + errors.map((e) => e.message).join('; '), errors);
  return { set, unset };
}

const putBody = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Valor novo; vazio mantém o atual; `null` remove. */
  secrets: z.record(z.string(), z.string().max(4000).nullable()).optional(),
});

function webhookUrl(ctx: AppContext, def: IntegrationDef, row: IntegrationRow | null) {
  if (!def.webhook || !row?.webhookToken) return null;
  return `${ctx.config.API_URL.replace(/\/+$/, '')}/api/webhooks/${def.key}/${row.webhookToken}`;
}

/** Visão segura para o navegador: segredos só como "configurado" + 4 últimos caracteres. */
function view(ctx: AppContext, def: IntegrationDef, row: IntegrationRow | null) {
  const secrets = row ? decryptSecrets(ctx, row) : {};
  const { lastTestAt, ...stored } = (row?.publicConfig ?? {}) as Record<string, unknown>;
  const config = { ...integrationDefaults(def), ...stored };
  return {
    provider: def.key,
    label: def.label,
    saved: Boolean(row),
    enabled: row?.enabled ?? false,
    status: row?.status ?? 'not_configured',
    lastError: row?.lastError ?? null,
    lastTestAt: typeof lastTestAt === 'string' ? lastTestAt : null,
    updatedAt: row?.updatedAt ?? null,
    config,
    secrets: Object.fromEntries(def.fields.filter((f) => f.type === 'secret').map((f) => [f.key, maskSecret(secrets[f.key])])),
    missing: missingIntegrationFields(def, config, Object.keys(secrets)),
    webhookUrl: webhookUrl(ctx, def, row),
    platformFallback: def.key === 'smtp' ? Boolean(ctx.config.SMTP_URL) : def.key === 'ai' ? Boolean(ctx.config.ANTHROPIC_API_KEY) : false,
  };
}

export async function integrationRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const { db } = ctx;
  const manage = { preHandler: guard('integrations.manage') };

  const defOf = (provider: string) => {
    if (provider === 'ai') throw forbidden('A IA � administrada pelo propriet�rio do sistema no painel global.');
    const def = getIntegrationDef(provider);
    if (!def) throw notFound('Integração');
    return def;
  };

  app.get('/integrations', manage, async (req) => {
    const user = requireUser(req);
    const rows = await db.query.integrations.findMany({ where: eq(integrations.officeId, user.officeId) });
    return INTEGRATION_CATALOG.filter((def) => def.key !== 'ai').map((def) => view(ctx, def, rows.find((r) => r.provider === def.key) ?? null));
  });

  /** Certificados A1 cadastrados nos procuradores (para a autenticação do SERPRO). */
  app.get('/integrations/serpro/certificates', manage, async (req) => {
    const user = requireUser(req);
    const rows = await db.query.procurators.findMany({ where: eq(procurators.officeId, user.officeId), orderBy: asc(procurators.name) });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      cpfCnpj: p.cpfCnpj,
      hasCertificate: Boolean(p.certificateFileId && p.certificatePasswordEnc),
      certificateExpiresAt: p.certificateExpiresAt,
    }));
  });

  app.put('/integrations/:provider', manage, async (req) => {
    const user = requireUser(req);
    const { provider } = parse(providerParam, req.params);
    const def = defOf(provider);
    const body = parse(putBody, req.body);
    const row = await getIntegrationRow(ctx, user.officeId, provider);

    const { set, unset } = parseConfig(def, body.config ?? {});
    const storedConfig = { ...(row?.publicConfig ?? {}) } as Record<string, unknown>;
    const nextConfig: Record<string, unknown> = { ...storedConfig, ...set };
    for (const k of unset) delete nextConfig[k];
    for (const k of Object.keys(nextConfig)) if (!SERVER_KEYS.has(k) && !def.fields.some((f) => f.key === k)) delete nextConfig[k];

    const secretFields = new Set(def.fields.filter((f) => f.type === 'secret').map((f) => f.key));
    const secrets = row ? decryptSecrets(ctx, row) : {};
    const changedSecrets: string[] = [];
    for (const [k, v] of Object.entries(body.secrets ?? {})) {
      if (!secretFields.has(k)) continue;
      if (v === null) {
        if (k in secrets) changedSecrets.push(k);
        delete secrets[k];
      } else if (v.trim() && v.trim() !== secrets[k]) {
        secrets[k] = v.trim();
        changedSecrets.push(k);
      }
    }

    const effective = { ...integrationDefaults(def), ...nextConfig };
    const missing = missingIntegrationFields(def, effective, Object.keys(secrets));
    const enabled = body.enabled ?? row?.enabled ?? missing.length === 0;
    if (enabled && missing.length) throw badRequest(`Para ativar, preencha: ${missing.join(', ')}.`, missing.map((m) => ({ path: 'config', message: m })));

    const changedConfig = [...Object.keys(set), ...unset].filter((k) => JSON.stringify(storedConfig[k]) !== JSON.stringify(nextConfig[k]));
    const credentialsChanged = !row || changedSecrets.length > 0 || changedConfig.length > 0;
    const status = missing.length ? 'not_configured' : credentialsChanged ? 'configured' : (row?.status ?? 'configured');
    const values = {
      enabled,
      publicConfig: nextConfig,
      secretsEnc: Object.keys(secrets).length ? ctx.secrets.encryptJson(secrets) : null,
      status,
      lastError: credentialsChanged ? null : (row?.lastError ?? null),
      webhookToken: row?.webhookToken ?? (def.webhook ? randomToken(24) : null),
      updatedAt: new Date(),
    };
    const [saved] = row
      ? await db.update(integrations).set(values).where(eq(integrations.id, row.id)).returning()
      : await db.insert(integrations).values({ officeId: user.officeId, provider, ...values }).returning();

    if (provider === 'serpro' && credentialsChanged) clearSerproTokens(`${user.officeId}:`);
    if (provider === 'serpro') await (enabled ? scheduleEcacDailySync(ctx, user.officeId) : cancelEcacDailySync(ctx, user.officeId));
    if (provider === 'omie' && enabled) await scheduleOmiePoll(ctx, user.officeId, effective as Partial<OmieConfig>, 60_000);
    // integração de cobrança pronta: emite o que ficou pendente (aprovado antes de configurar, falha de credencial...)
    const requeuedBillings = enabled && status !== 'not_configured' ? await requeuePendingBillings(ctx, user.officeId, provider, user.userId) : 0;
    await audit(req, 'integration.update', 'integration', saved.id, { provider, enabled, changedConfig, changedSecrets, ...(requeuedBillings ? { requeuedBillings } : {}) });
    return view(ctx, def, saved);
  });

  app.post('/integrations/:provider/test', manage, async (req) => {
    const user = requireUser(req);
    const { provider } = parse(providerParam, req.params);
    const def = defOf(provider);
    const { sendTo } = parse(z.object({ sendTo: z.preprocess((v) => (empty(v) ? undefined : v), z.string().trim().max(320).optional()) }), req.body);
    const row = await getIntegrationRow(ctx, user.officeId, provider);
    if (!row && provider !== 'ai') throw badRequest('Salve a configuração antes de testar.');

    let ok = true;
    let message: string;
    try {
      message = await testIntegration(ctx, user.officeId, provider, { sendTo });
    } catch (err) {
      ok = false;
      message = err instanceof IntegrationError ? err.message : `Erro inesperado no teste: ${errorMessage(err)}`;
    }
    let updated = row;
    if (row) {
      [updated] = await db
        .update(integrations)
        .set({
          status: ok ? 'connected' : 'error',
          lastError: ok ? null : message.slice(0, 1000),
          publicConfig: { ...row.publicConfig, lastTestAt: new Date().toISOString() },
        })
        .where(eq(integrations.id, row.id))
        .returning();
    }
    await audit(req, 'integration.test', 'integration', row?.id ?? null, { provider, ok });
    return { ok, message, integration: view(ctx, def, updated ?? null) };
  });

  /** Gera um novo token para a URL do webhook (a antiga deixa de funcionar). */
  app.post('/integrations/:provider/webhook-token', manage, async (req) => {
    const user = requireUser(req);
    const { provider } = parse(providerParam, req.params);
    const def = defOf(provider);
    if (!def.webhook) throw badRequest('Esta integração não recebe webhooks.');
    const row = await getIntegrationRow(ctx, user.officeId, provider);
    if (!row) throw badRequest('Salve a configuração antes de gerar a URL do webhook.');
    const [saved] = await db
      .update(integrations)
      .set({ webhookToken: randomToken(24), updatedAt: new Date() })
      .where(eq(integrations.id, row.id))
      .returning();
    await audit(req, 'integration.webhook_token', 'integration', row.id, { provider });
    return view(ctx, def, saved);
  });

  app.delete('/integrations/:provider', manage, async (req, reply) => {
    const user = requireUser(req);
    const { provider } = parse(providerParam, req.params);
    defOf(provider);
    const deleted = await db
      .delete(integrations)
      .where(and(eq(integrations.officeId, user.officeId), eq(integrations.provider, provider)))
      .returning({ id: integrations.id });
    if (!deleted.length) throw notFound('Integração');
    if (provider === 'serpro') {
      clearSerproTokens(`${user.officeId}:`);
      await cancelEcacDailySync(ctx, user.officeId);
    }
    await audit(req, 'integration.delete', 'integration', deleted[0].id, { provider });
    return reply.status(204).send();
  });
}
