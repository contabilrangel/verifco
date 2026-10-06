import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../context';
import { auditLogs } from '../db/schema';
import { badRequest, forbidden, unauthorized } from './errors';

// ----------------------------------------------------------------------------
// Mensagens de validação em português do Brasil
// ----------------------------------------------------------------------------
type ZodIssueLike = {
  code?: string;
  input?: unknown;
  expected?: string;
  origin?: string;
  minimum?: number | bigint | Date;
  maximum?: number | bigint | Date;
  inclusive?: boolean;
  format?: string;
  values?: unknown[];
  keys?: string[];
  divisor?: number | bigint;
};

const FORMAT_MESSAGES: Record<string, string> = {
  email: 'E-mail inválido.',
  uuid: 'Identificador inválido.',
  guid: 'Identificador inválido.',
  url: 'Endereço (URL) inválido.',
  date: 'Data inválida. Use o formato AAAA-MM-DD.',
  datetime: 'Data e hora inválidas.',
  time: 'Hora inválida.',
};

const TYPE_MESSAGES: Record<string, string> = {
  string: 'Informe um texto.',
  number: 'Informe um número.',
  int: 'Informe um número inteiro.',
  boolean: 'Informe sim ou não.',
  array: 'Informe uma lista.',
  date: 'Informe uma data.',
};

/** Mensagem padrão (pt-BR) para os erros do zod sem mensagem própria no esquema. */
export function ptBrIssueMessage(issue: ZodIssueLike): string {
  const n = (v: unknown) => (v instanceof Date ? v.toLocaleDateString('pt-BR') : String(v));
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null) return 'Campo obrigatório.';
      return TYPE_MESSAGES[issue.expected ?? ''] ?? 'Valor inválido.';
    case 'too_small': {
      const min = issue.minimum;
      if (issue.origin === 'string') return Number(min) <= 1 ? 'Campo obrigatório.' : `Use ao menos ${n(min)} caracteres.`;
      if (issue.origin === 'array' || issue.origin === 'set') return Number(min) <= 1 ? 'Selecione ao menos um item.' : `Selecione ao menos ${n(min)} itens.`;
      if (issue.origin === 'date') return `A data deve ser a partir de ${n(min)}.`;
      return issue.inclusive === false ? `O valor deve ser maior que ${n(min)}.` : `O valor mínimo é ${n(min)}.`;
    }
    case 'too_big': {
      const max = issue.maximum;
      if (issue.origin === 'string') return `Use no máximo ${n(max)} caracteres.`;
      if (issue.origin === 'array' || issue.origin === 'set') return `Selecione no máximo ${n(max)} itens.`;
      if (issue.origin === 'file') return 'O arquivo é grande demais.';
      if (issue.origin === 'date') return `A data deve ser até ${n(max)}.`;
      return issue.inclusive === false ? `O valor deve ser menor que ${n(max)}.` : `O valor máximo é ${n(max)}.`;
    }
    case 'invalid_format':
      return FORMAT_MESSAGES[issue.format ?? ''] ?? 'Formato inválido.';
    case 'invalid_value':
      return 'Opção inválida.';
    case 'not_multiple_of':
      return `O valor deve ser múltiplo de ${n(issue.divisor)}.`;
    case 'unrecognized_keys':
      return `Campo não reconhecido: ${(issue.keys ?? []).join(', ')}.`;
    default:
      return 'Valor inválido.';
  }
}

z.config({ localeError: (issue) => ptBrIssueMessage(issue as ZodIssueLike) });

/** Nomes dos campos para as mensagens (o caminho técnico continua em `details`). */
const FIELD_LABELS: Record<string, string> = {
  email: 'E-mail',
  password: 'Senha',
  newPassword: 'Nova senha',
  currentPassword: 'Senha atual',
  name: 'Nome',
  officeName: 'Nome do escritório',
  officeDocument: 'CPF/CNPJ do escritório',
  token: 'Link',
  cpf: 'CPF',
  cpfCnpj: 'CPF/CNPJ',
  code: 'Código',
  year: 'Ano',
  phone: 'Telefone',
  mobile: 'Celular',
  birthDate: 'Data de nascimento',
  roleId: 'Função',
  permissions: 'Permissões',
  title: 'Título',
  subject: 'Assunto',
  body: 'Mensagem',
  content: 'Mensagem',
  description: 'Descrição',
  dueDate: 'Vencimento',
  amountCents: 'Valor',
  valueCents: 'Valor',
  category: 'Categoria',
  status: 'Situação',
  website: 'Site',
  state: 'UF',
  city: 'Cidade',
  zip: 'CEP',
};

const labelOf = (path: PropertyKey[]) => {
  const key = [...path].reverse().find((p) => typeof p === 'string');
  return typeof key === 'string' ? FIELD_LABELS[key] : undefined;
};

/** "Nome: use ao menos 2 caracteres." — sem repetir o rótulo quando a mensagem já fala do campo. */
const withLabel = (label: string | undefined, message: string) => {
  if (!label || message.toLowerCase().includes(label.toLowerCase())) return message;
  return `${label}: ${message.charAt(0).toLowerCase()}${message.slice(1)}`;
};

/** Valida `data` com zod e devolve 400 com a mensagem em português e a lista de campos inválidos. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const messages = [...new Set(r.error.issues.map((i) => withLabel(labelOf(i.path), i.message)))];
    throw badRequest(messages.length === 1 ? messages[0] : `Dados inválidos: ${messages.join('; ')}`, fields);
  }
  return r.data;
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function can(user: AuthUser, permission: string): boolean {
  return user.isOwner || user.permissions.has(permission);
}

/** Garante login e ao menos uma das permissões informadas. */
export function requirePermission(req: FastifyRequest, ...permissions: string[]): AuthUser {
  const user = requireUser(req);
  if (permissions.length && !permissions.some((p) => can(user, p))) throw forbidden();
  return user;
}

/** preHandler equivalente, para declarar a permissão junto da rota. */
export const guard =
  (...permissions: string[]) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    requirePermission(req, ...permissions);
  };

export async function audit(
  req: FastifyRequest,
  action: string,
  entity: string,
  entityId?: string | null,
  data?: Record<string, unknown>,
) {
  const user = req.auth;
  if (!user) return;
  await req.server.ctx.db.insert(auditLogs).values({
    officeId: user.officeId,
    userId: user.userId,
    action,
    entity,
    entityId: entityId ?? null,
    data: data ?? null,
  });
}

// ----------------------------------------------------------------------------
// Esquemas reutilizáveis
// ----------------------------------------------------------------------------
export const uuidParam = z.object({ id: z.uuid() });
export const yearSchema = z.coerce.number().int().min(2000).max(2100);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
export const centsSchema = z.coerce.number().int().min(0);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
});

export function paginate<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { data: rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const optionalText = z.preprocess(emptyToNull, z.string().trim().max(5000).nullable().optional());
