/**
 * Dados de demonstração do Verifco.
 *
 *   pnpm --filter @verifco/api db:seed
 *
 * Cria um escritório de demonstração completo usando a própria aplicação (as rotas reais
 * via `app.inject`), então todas as regras de validação, status e cálculo valem como no uso
 * normal. Usa provedores falsos: nenhum e-mail ou WhatsApp sai do servidor.
 *
 * É seguro rodar de novo: se o usuário de demonstração já existir, não faz nada.
 * Em produção só roda com `--force`.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { addDaysIso, todayIso } from '@verifco/shared';
import { buildApp } from '../app';
import { createContext } from '../bootstrap';
import { MemoryProviders } from '../integrations/providers';
import { contracts, users } from './schema';

const DEMO_EMAIL = 'demo@verifco.dev';
const DEMO_PASSWORD = 'verifco-demo-123';
const STAFF_PASSWORD = 'verifco-equipe-123';

// ---------------------------------------------------------------------------------- utilitários

/** Gerador pseudoaleatório determinístico (mesma base de dados a cada execução). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260406);
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];

/** CPF válido a partir de 9 dígitos (calcula os dois verificadores). */
function cpfFrom(base: number[]) {
  const dv = (digits: number[]) => {
    const sum = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}

const usedCpfs = new Set<string>();
function newCpf() {
  for (;;) {
    const base = Array.from({ length: 9 }, () => between(0, 9));
    if (new Set(base).size === 1) continue;
    const cpf = cpfFrom(base);
    if (usedCpfs.has(cpf)) continue;
    usedCpfs.add(cpf);
    return cpf;
  }
}

/** CNPJ válido a partir de 12 dígitos. */
function cnpjFrom(base: number[]) {
  const dv = (digits: number[], weights: number[]) => {
    const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('');
}
const newCnpj = () => cnpjFrom([...Array.from({ length: 8 }, () => between(0, 9)), 0, 0, 0, 1]);

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '');

const reais = (v: number) => Math.round(v * 100);
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Client {
  call<T = any>(method: Method, url: string, payload?: unknown): Promise<T>;
  get<T = any>(url: string): Promise<T>;
  post<T = any>(url: string, payload?: unknown): Promise<T>;
  put<T = any>(url: string, payload?: unknown): Promise<T>;
  patch<T = any>(url: string, payload?: unknown): Promise<T>;
  upload<T = any>(url: string, files: { name: string; data: Buffer; type: string }[], fields?: Record<string, string>): Promise<T>;
}

function client(app: FastifyInstance, token: string | null): Client {
  const headers = (extra: Record<string, string> = {}) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
  const call = async <T>(method: Method, url: string, payload?: unknown): Promise<T> => {
    const res = await app.inject({ method, url, payload: payload as never, headers: headers() });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 400)}`);
    const type = String(res.headers['content-type'] ?? '');
    return (type.includes('application/json') ? res.json() : res.body) as T;
  };
  return {
    call,
    get: (url) => call('GET', url),
    post: (url, payload) => call('POST', url, payload ?? {}),
    put: (url, payload) => call('PUT', url, payload ?? {}),
    patch: (url, payload) => call('PATCH', url, payload ?? {}),
    upload: async (url, files, fields = {}) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const f of files) fd.append('file', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
      const req = new Request('http://seed.local/', { method: 'POST', body: fd });
      const body = Buffer.from(await req.arrayBuffer());
      const res = await app.inject({ method: 'POST', url, payload: body, headers: headers({ 'content-type': req.headers.get('content-type')! }) });
      if (res.statusCode >= 400) throw new Error(`POST ${url} → ${res.statusCode}: ${res.body.slice(0, 400)}`);
      return res.json();
    },
  };
}

// ------------------------------------------------------------------------------------- dados

const FIRST = ['Maria', 'João', 'Ana', 'Pedro', 'Juliana', 'Carlos', 'Fernanda', 'Lucas', 'Patrícia', 'Rafael', 'Camila', 'Marcelo', 'Beatriz', 'Gustavo', 'Larissa', 'Ricardo', 'Aline', 'Thiago', 'Renata', 'Bruno', 'Vanessa', 'Eduardo', 'Simone', 'André', 'Cláudia', 'Felipe', 'Mariana', 'Roberto', 'Tatiane', 'Sérgio', 'Helena', 'Otávio'];
const LAST = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Lima', 'Araújo', 'Fernandes', 'Carvalho', 'Gomes', 'Martins', 'Rocha', 'Ribeiro', 'Barbosa', 'Mendes', 'Cardoso'];
const CITIES: [string, string, string][] = [
  ['Belo Horizonte', 'MG', '30130-010'],
  ['São Paulo', 'SP', '01310-100'],
  ['Campinas', 'SP', '13010-111'],
  ['Curitiba', 'PR', '80010-000'],
  ['Rio de Janeiro', 'RJ', '20040-020'],
  ['Juiz de Fora', 'MG', '36010-000'],
];
const STREETS = ['Rua da Bahia', 'Avenida Paulista', 'Rua XV de Novembro', 'Avenida Afonso Pena', 'Rua das Flores', 'Avenida Brasil', 'Rua Halfeld', 'Rua Sergipe'];
const EMPLOYERS = ['Hospital Santa Clara Ltda', 'Construtora Horizonte S.A.', 'Banco Mercantil do Brasil S.A.', 'Prefeitura Municipal', 'Indústria Metalúrgica Vale Ltda', 'Universidade Federal', 'Tech Soluções Digitais Ltda'];
const BANKS = ['Banco do Brasil S.A.', 'Caixa Econômica Federal', 'Itaú Unibanco S.A.', 'Banco Bradesco S.A.', 'Nubank (Nu Pagamentos S.A.)', 'Banco Inter S.A.'];

/** Perfis de contribuinte usados para variar as declarações (e acionar o Radar). */
type Profile = 'clt' | 'medico' | 'aposentado' | 'investidor' | 'rural' | 'autonomo' | 'empresario';
const PROFILES: Profile[] = ['clt', 'clt', 'clt', 'medico', 'aposentado', 'investidor', 'autonomo', 'empresario', 'clt', 'rural'];

interface Person {
  id: string;
  name: string;
  cpf: string;
  email: string | null;
  mobile: string | null;
  profile: Profile;
  index: number;
}

/** Linhas da DIRPF de um contribuinte num exercício (valores crescem ano a ano). */
function itemsFor(p: Person, year: number) {
  const growth = 1 + (year - 2024) * 0.08;
  const v = (x: number) => reais(Math.round(x * growth * 100) / 100);
  const prev = (x: number) => reais(Math.round((x * growth) / 1.08 * 100) / 100);
  const employer = EMPLOYERS[p.index % EMPLOYERS.length];
  const bank = BANKS[p.index % BANKS.length];
  const items: Record<string, unknown>[] = [];
  const cnpj = newCnpj();

  // rendimentos
  if (p.profile === 'aposentado') {
    items.push({ kind: 'income_pj', counterpartyDoc: '29979036000140', counterpartyName: 'Instituto Nacional do Seguro Social', valueCents: v(68_400), withheldCents: v(3_950), extra: { officialPensionCents: 0 } });
    items.push({ kind: 'income_exempt', code: '10', description: 'Parcela isenta de aposentadoria (65 anos ou mais)', valueCents: v(24_751.74), extra: { nature: 'retirement' } });
  } else if (p.profile === 'autonomo') {
    items.push({ kind: 'income_pf', description: 'Honorários de consultoria recebidos de pessoas físicas (Carnê-Leão)', valueCents: v(96_000), extra: {} });
    items.push({ kind: 'income_pj', counterpartyDoc: cnpj, counterpartyName: employer, valueCents: v(38_000), withheldCents: v(1_900), extra: { officialPensionCents: v(4_180) } });
  } else if (p.profile === 'empresario') {
    items.push({ kind: 'income_pj', counterpartyDoc: cnpj, counterpartyName: `${p.name.split(' ')[0]} Participações Ltda`, description: 'Pró-labore', valueCents: v(180_000), withheldCents: v(28_400), extra: { officialPensionCents: v(19_800) } });
    items.push({ kind: 'income_exempt', code: '09', counterpartyDoc: cnpj, counterpartyName: `${p.name.split(' ')[0]} Participações Ltda`, description: 'Lucros e dividendos recebidos', valueCents: v(1_450_000), extra: { nature: 'dividends' } });
  } else if (p.profile === 'medico') {
    items.push({ kind: 'income_pj', counterpartyDoc: cnpj, counterpartyName: 'Hospital Santa Clara Ltda', valueCents: v(312_000), withheldCents: v(71_300), extra: { officialPensionCents: v(9_800) } });
    items.push({ kind: 'income_pf', description: 'Consultas particulares (Carnê-Leão)', valueCents: v(144_000), extra: {} });
  } else if (p.profile === 'rural') {
    items.push({ kind: 'rural_income', description: 'Venda de café arábica', valueCents: v(420_000), extra: {} });
    items.push({ kind: 'rural_expense', description: 'Insumos, adubos e mão de obra', valueCents: v(265_000), extra: {} });
    items.push({ kind: 'rural_asset', description: 'Trator Massey Ferguson 4275', valueCents: v(180_000), prevValueCents: prev(180_000), extra: {} });
  } else {
    const salary = between(48, 160) * 1000;
    items.push({ kind: 'income_pj', counterpartyDoc: cnpj, counterpartyName: employer, valueCents: v(salary), withheldCents: v(Math.round(salary * 0.11)), extra: { officialPensionCents: v(Math.round(salary * 0.09)) } });
    items.push({ kind: 'income_exclusive', code: '01', counterpartyDoc: cnpj, counterpartyName: employer, description: '13º salário', valueCents: v(Math.round(salary / 12)), extra: { nature: 'thirteenth' } });
  }
  items.push({ kind: 'income_exempt', code: '12', counterpartyName: bank, description: 'Rendimentos de caderneta de poupança', valueCents: v(between(300, 4200)), extra: { nature: 'financial_exempt' } });
  if (p.profile === 'investidor') {
    items.push({ kind: 'income_exclusive', code: '06', counterpartyName: 'XP Investimentos CCTVM S.A.', description: 'Rendimentos de aplicações financeiras (CDB)', valueCents: v(38_500), extra: { nature: 'financial_taxed' } });
    items.push({ kind: 'variable_income', description: 'Operações comuns em bolsa — ganho líquido no ano', valueCents: v(52_300), extra: {} });
    items.push({ kind: 'income_exempt', code: '20', description: 'Ganhos líquidos em vendas de ações até R$ 20 mil/mês', valueCents: v(14_800), extra: { nature: 'stock_market' } });
  }

  // dependentes (cônjuge e filhos)
  const married = p.index % 3 !== 2;
  const spouseFirst = pick(['Cristina', 'Paulo', 'Luciana', 'Márcio', 'Daniela', 'Fábio']);
  if (married && p.index % 2 === 0) {
    items.push({ kind: 'dependent', ownerName: `${spouseFirst} ${p.name.split(' ').slice(-1)[0]}`, ownerCpf: newCpf(), extra: { relationship: 'spouse', birthDate: `19${between(70, 89)}-0${between(1, 9)}-1${between(0, 9)}` } });
  }
  const kids = p.index % 4;
  for (let k = 0; k < kids; k++) {
    items.push({
      kind: 'dependent',
      ownerName: `${pick(['Laura', 'Miguel', 'Sofia', 'Arthur', 'Alice', 'Davi', 'Valentina', 'Heitor'])} ${p.name.split(' ').slice(-1)[0]}`,
      ownerCpf: newCpf(),
      extra: { relationship: k === 0 && p.index % 5 === 0 ? 'child_student' : 'child', birthDate: `20${String(between(5, 19)).padStart(2, '0')}-0${between(1, 9)}-2${between(0, 8)}` },
    });
  }

  // pagamentos
  items.push({ kind: 'payment', code: '26', counterpartyDoc: newCnpj(), counterpartyName: 'Unimed Cooperativa de Trabalho Médico', description: 'Plano de saúde — titular e dependentes', valueCents: v(between(4_800, 18_000)), extra: { nature: 'health' } });
  if (p.index % 2 === 0) {
    items.push({ kind: 'payment', code: '10', counterpartyDoc: newCpf(), counterpartyName: 'Dra. Paula Rezende', description: 'Consultas odontológicas', valueCents: v(between(800, 4_500)), extra: { nature: 'health', reimbursedCents: 0 } });
  }
  if (kids > 0) {
    items.push({ kind: 'payment', code: '01', counterpartyDoc: newCnpj(), counterpartyName: 'Colégio Santo Agostinho', description: 'Mensalidades escolares', valueCents: v(between(14_000, 38_000)), extra: { nature: 'education' } });
  }
  if (p.profile === 'empresario' || p.profile === 'medico') {
    items.push({ kind: 'payment', code: '36', counterpartyDoc: newCnpj(), counterpartyName: 'Brasilprev Seguros e Previdência S.A.', description: 'Previdência complementar (PGBL)', valueCents: v(24_000), extra: { nature: 'private_pension' } });
  }
  if (p.index % 7 === 3) {
    items.push({ kind: 'payment', code: '30', counterpartyDoc: newCpf(), counterpartyName: 'Rita de Cássia Moura', description: 'Pensão alimentícia judicial', valueCents: v(18_000), extra: { nature: 'alimony' } });
  }
  if (p.index % 9 === 4) {
    items.push({ kind: 'donation', code: '80', counterpartyDoc: newCnpj(), counterpartyName: 'Fundo Municipal da Criança e do Adolescente', description: 'Doação ao FIA', valueCents: v(1_500), extra: {} });
  }

  // bens e direitos (vários grupos)
  const city = CITIES[p.index % CITIES.length];
  items.push({ kind: 'asset', groupCode: '06', code: '01', counterpartyName: bank, description: `Conta corrente no ${bank}`, prevValueCents: prev(between(2_000, 30_000)), valueCents: v(between(2_000, 40_000)), extra: {} });
  items.push({ kind: 'asset', groupCode: '04', code: '01', counterpartyName: bank, description: 'Caderneta de poupança', prevValueCents: prev(between(5_000, 60_000)), valueCents: v(between(5_000, 70_000)), extra: {} });
  if (p.index % 3 !== 1 || p.profile === 'empresario') {
    const house = between(280, 900) * 1000;
    items.push({ kind: 'asset', groupCode: '01', code: '11', description: `Apartamento residencial em ${city[0]}/${city[1]}, matrícula ${between(10_000, 99_999)}`, prevValueCents: reais(house), valueCents: reais(house), extra: {} });
  }
  if (p.profile === 'empresario' || p.profile === 'investidor') {
    items.push({ kind: 'asset', groupCode: '01', code: '12', description: `Sala comercial em ${city[0]}/${city[1]}, alugada`, prevValueCents: reais(650_000), valueCents: reais(650_000), extra: {} });
    items.push({ kind: 'asset', groupCode: '01', code: '14', description: 'Terreno urbano em condomínio fechado', prevValueCents: reais(420_000), valueCents: reais(420_000), extra: {} });
    items.push({ kind: 'asset', groupCode: '03', code: '02', counterpartyDoc: cnpj, counterpartyName: `${p.name.split(' ')[0]} Participações Ltda`, description: 'Quotas de capital social (99%)', prevValueCents: reais(500_000), valueCents: reais(500_000), extra: {} });
  }
  if (p.index % 2 === 1) {
    items.push({ kind: 'asset', groupCode: '02', code: '01', description: `Automóvel ${pick(['Toyota Corolla', 'Honda HR-V', 'VW T-Cross', 'Fiat Pulse', 'Jeep Compass'])} ${year - 3}, placa ${pick(['QWE', 'RTY', 'HJK'])}${between(1, 9)}A${between(10, 99)}`, prevValueCents: reais(between(80, 160) * 1000), valueCents: reais(between(80, 160) * 1000), extra: {} });
  }
  if (p.profile === 'investidor' || p.index % 6 === 1) {
    items.push({ kind: 'asset', groupCode: '08', code: '01', counterpartyName: 'Mercado Bitcoin', description: `${(0.05 + p.index / 100).toFixed(4)} BTC custodiados em exchange nacional`, prevValueCents: prev(between(18_000, 90_000)), valueCents: v(between(18_000, 90_000)), extra: {} });
  }
  if (p.profile === 'investidor') {
    items.push({ kind: 'asset', groupCode: '08', code: '02', counterpartyName: 'Binance', description: '3,2 ETH em carteira de exchange', prevValueCents: prev(28_000), valueCents: v(31_500), extra: {} });
    items.push({ kind: 'asset', groupCode: '03', code: '01', counterpartyName: 'XP Investimentos CCTVM S.A.', description: 'Ações PETR4, VALE3 e ITUB4', prevValueCents: prev(210_000), valueCents: v(245_000), extra: {} });
    items.push({ kind: 'asset', groupCode: '07', code: '03', counterpartyName: 'XP Investimentos CCTVM S.A.', description: 'Cotas de fundo imobiliário (FII)', prevValueCents: prev(95_000), valueCents: v(102_000), extra: {} });
  }
  if (p.index % 5 === 2) {
    items.push({ kind: 'asset', groupCode: '05', code: '03', counterpartyDoc: newCpf(), counterpartyName: 'Antônio Ferreira', description: 'Empréstimo concedido a terceiro', prevValueCents: reais(20_000), valueCents: reais(12_000), extra: {} });
  }

  // dívidas
  if (p.index % 3 === 0) {
    items.push({ kind: 'debt', code: '11', counterpartyDoc: '00360305000104', counterpartyName: 'Caixa Econômica Federal', description: 'Financiamento imobiliário (SFH)', prevValueCents: prev(310_000), valueCents: v(280_000) - reais(30_000), extra: {} });
  }
  if (p.index % 8 === 5) {
    items.push({ kind: 'debt', code: '12', counterpartyName: 'Banco Itaú Unibanco S.A.', description: 'Empréstimo pessoal consignado', prevValueCents: reais(35_000), valueCents: reais(22_000), extra: {} });
  }
  return items;
}

// ------------------------------------------------------------------------------------ script

async function main() {
  const force = process.argv.includes('--force');
  const providers = new MemoryProviders();
  // o seed define a senha dos colaboradores pelo link de convite devolvido na resposta (só fora de produção)
  const { ctx, close } = await createContext({ RUN_WORKER: false, DEV_SHOW_ACCESS_CODES: true }, { providers });
  if (ctx.config.NODE_ENV === 'production' && !force) {
    console.error('Recusado: NODE_ENV=production. Use --force se quiser mesmo criar dados de demonstração.');
    await close();
    process.exit(1);
  }
  const app = await buildApp(ctx);
  await app.ready();
  const finish = async () => {
    await app.close();
    await close();
  };

  const existing = await ctx.db.query.users.findFirst({ where: sql`lower(${users.email}) = ${DEMO_EMAIL}` });
  if (existing) {
    console.log(`O escritório de demonstração já existe (${DEMO_EMAIL}). Nada foi alterado.`);
    console.log(`Entre com ${DEMO_EMAIL} / ${DEMO_PASSWORD}.`);
    await finish();
    return;
  }

  const anon = client(app, null);
  const log = (msg: string) => console.log(`• ${msg}`);

  // ---------------------------------------------------------------- escritório e equipe
  const reg = await anon.post<{ token: string; office: { id: string }; user: { id: string } }>('/api/auth/register', {
    officeName: 'Rangel & Associados Contabilidade',
    officeDocument: '11222333000181',
    name: 'Ana Rangel',
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });
  const owner = client(app, reg.token);
  const ownerId = reg.user.id;
  await owner.put('/api/office', {
    name: 'Rangel & Associados Contabilidade',
    cpfCnpj: '11222333000181',
    email: 'contato@rangel-demo.com.br',
    phone: '(31) 3333-4455',
    website: 'rangel-demo.com.br',
    city: 'Belo Horizonte',
    state: 'MG',
  });
  // pacote de demonstração: só com a avaliação de 30 dias, o escritório ficaria em consulta depois do prazo
  const today = todayIso();
  await ctx.db.insert(contracts).values({
    officeId: reg.office.id,
    name: 'Pacote de demonstração',
    plan: 'basic',
    declarationLimit: null,
    year: Number(today.slice(0, 4)),
    startsAt: today,
    expiresAt: addDaysIso(today, 365),
    hasBackup: true,
  });
  log('escritório criado');

  const roles = await owner.get<{ id: string; name: string }[]>('/api/roles');
  const contador = roles.find((r) => r.name === 'Contador')!;
  const assistente = await owner.post<{ id: string }>('/api/roles', {
    name: 'Assistente',
    permissions: ['customer.list', 'customer.create', 'customer.edit', 'declaration.view', 'declaration.edit', 'checklist_digital.view', 'checklist_digital.create', 'checklist_digital.edit', 'message.send', 'darf.view'],
  });
  const staff: { id: string; name: string }[] = [];
  for (const [name, email, roleId] of [
    ['Bruno Teixeira', 'bruno.teixeira@verifco.dev', contador.id],
    ['Carla Menezes', 'carla.menezes@verifco.dev', assistente.id],
  ] as const) {
    const emp = await owner.post<{ id: string; inviteLink: string }>('/api/employees', { name, email, roleId });
    const token = new URL(emp.inviteLink).searchParams.get('token');
    await anon.post('/api/auth/reset-password', { token, password: STAFF_PASSWORD });
    staff.push({ id: emp.id, name });
  }
  log('2 colaboradores criados');

  const groupNames = ['Clientes premium', 'Médicos e saúde', 'Aposentados', 'Investidores', 'Holding familiar'];
  const groups: Record<string, string> = {};
  for (const name of groupNames) groups[name] = (await owner.post<{ id: string }>('/api/customer-groups', { name })).id;
  log(`${groupNames.length} grupos criados`);

  const procurator = await owner.post<{ id: string }>('/api/procurators', {
    name: 'Ana Rangel',
    cpfCnpj: cpfFrom([5, 2, 9, 9, 8, 2, 2, 4, 7]),
    authType: 'certificate_local',
    userId: ownerId,
    certificateExpiresAt: '2027-03-31',
  });
  log('procurador criado');

  // ---------------------------------------------------------------- financeiro (catálogo)
  const methods = await owner.get<{ id: string; type: string }[]>('/api/finance/payment-methods');
  await owner.post('/api/finance/payment-methods', { type: 'bank_transfer', name: 'Transferência bancária', maxInstallments: 1, active: true, isDefault: false });
  const pix = methods.find((m) => m.type === 'pix')!.id;
  const boleto = methods.find((m) => m.type === 'boleto')!.id;
  const card = methods.find((m) => m.type === 'credit_card')!.id;
  await owner.post('/api/finance/price-tables', {
    name: 'Declaração completa por itens',
    type: 'items',
    validFrom: '2026-01-01',
    config: {
      items: [
        { code: 'DEC', label: 'Declaração base', unitPriceCents: 25_000 },
        { code: 'DEP', label: 'Dependente', unitPriceCents: 4_000 },
        { code: 'IMOV', label: 'Imóvel', unitPriceCents: 3_000 },
        { code: 'GCAP', label: 'Apuração de ganho de capital', unitPriceCents: 35_000 },
      ],
    },
  });
  await owner.post('/api/finance/price-tables', { name: 'Consultoria por hora', type: 'hourly', validFrom: '2026-01-01', config: { hourRateCents: 22_000, minHours: 2 } });
  await owner.post('/api/finance/price-tables', { name: 'Percentual da restituição', type: 'percentage', validFrom: '2026-01-01', config: { percent: 10, base: 'refund', minCents: 25_000, maxCents: 150_000 } });
  log('métodos de pagamento e tabelas de cobrança');

  // ---------------------------------------------------------------- clientes
  const people: Person[] = [];
  const responsibles = [ownerId, staff[0].id, staff[0].id, staff[1].id];
  for (let i = 0; i < 30; i++) {
    const name = `${FIRST[i % FIRST.length]} ${pick(LAST)} ${LAST[(i * 7) % LAST.length]}`;
    const cpf = newCpf();
    // alguns clientes sem e-mail ou celular, para os filtros e avisos de contato
    const email = i % 11 === 10 ? null : `${slug(name)}@exemplo.com.br`;
    const mobile = i % 9 === 8 ? null : `(${pick(['31', '11', '21', '41', '19'])}) 9${between(8000, 9999)}-${between(1000, 9999)}`;
    const created = await owner.post<{ id: string }>('/api/customers', { name, cpfCnpj: cpf, email, responsibleUserId: responsibles[i % responsibles.length] });
    const profile = PROFILES[i % PROFILES.length];
    const p: Person = { id: created.id, name, cpf, email, mobile, profile, index: i };
    people.push(p);

    const groupIds = [
      ...(profile === 'medico' ? [groups['Médicos e saúde']] : []),
      ...(profile === 'aposentado' ? [groups['Aposentados']] : []),
      ...(profile === 'investidor' ? [groups['Investidores']] : []),
      ...(profile === 'empresario' ? [groups['Holding familiar'], groups['Clientes premium']] : []),
      ...(i % 6 === 0 ? [groups['Clientes premium']] : []),
    ];
    await owner.put(`/api/customers/${p.id}/identification`, {
      name,
      birthDate: `19${between(55, 95)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
      sex: i % 2 === 0 ? 'F' : 'M',
      email,
      mobileCountry: '55',
      mobile,
      responsibleUserId: responsibles[i % responsibles.length],
      procuratorId: i % 3 === 0 ? procurator.id : null,
      status: i === 29 ? 'inactive' : 'active',
      groupIds: [...new Set(groupIds)],
      notes: i % 4 === 0 ? 'Prefere contato por WhatsApp no período da tarde.' : null,
    });
    const city = CITIES[i % CITIES.length];
    await owner.put(`/api/customers/${p.id}/address`, {
      address: { street: pick(STREETS), number: String(between(10, 2500)), complement: i % 2 ? `Apto ${between(101, 1204)}` : null, neighborhood: pick(['Centro', 'Savassi', 'Jardins', 'Batel', 'Botafogo', 'Cambuí']), city: city[0], state: city[1], zip: city[2] },
    });
    if (i % 3 === 0) await owner.put(`/api/customers/${p.id}/credentials`, { ecacLogin: cpf, ecacPassword: 'senha-de-exemplo' });
  }
  log(`${people.length} clientes com identificação e endereço`);

  // ---------------------------------------------------------------- declarações (3 exercícios)
  const YEARS = [2024, 2025, 2026];
  const declIds: Record<string, Record<number, string>> = {};
  const taxDue: { person: Person; declarationId: string; cents: number }[] = [];
  // situação de 2026 de cada cliente, espalhada pelas colunas do Kanban
  const SUBSTATUS_2026 = [
    'not_started', 'budget_sent', 'budget_approved', 'started', 'elaboration', 'missing_documents', 'review',
    'transmitted:processing', 'transmitted:refund_lot', 'transmitted:processed', 'transmitted:fine_mesh', 'finished',
  ];
  for (const p of people) {
    declIds[p.id] = {};
    for (const year of YEARS) {
      // nem todo cliente tem os 3 anos (clientes novos no escritório)
      if (year === 2024 && p.index % 5 === 4) continue;
      const decl = await owner.put<{ id: string }>(`/api/customers/${p.id}/declarations/${year}`, { taxation: p.profile === 'aposentado' || p.index % 4 === 3 ? 'simplified' : 'complete' });
      declIds[p.id][year] = decl.id;
      const lines = itemsFor(p, year);
      // anos anteriores com menos detalhes; 2026 completo para quem já começou
      const plan = year === 2026 ? SUBSTATUS_2026[p.index % SUBSTATUS_2026.length] : 'transmitted:processed';
      const count = year === 2026 && (plan === 'not_started' || plan === 'budget_sent') ? 0 : lines.length;
      for (const line of lines.slice(0, count)) await owner.post(`/api/declarations/${decl.id}/items`, line);

      const pays = p.profile === 'medico' || p.profile === 'autonomo' || p.profile === 'empresario' || p.index % 4 === 1;
      const cents = pays ? reais(between(800, 14_000)) : 0;
      const refund = pays ? 0 : reais(between(300, 6_500));
      if (plan.startsWith('transmitted') || plan === 'finished') {
        const ecac = plan.startsWith('transmitted:') ? plan.split(':')[1] : 'processed';
        await owner.put(`/api/customers/${p.id}/declarations/${year}`, {
          taxDueCents: cents,
          refundCents: refund,
          receiptNumber: `${String(year).slice(2)}.${between(10, 99)}.${between(100, 999)}.${between(100, 999)}-${between(10, 99)}`,
          transmittedAt: `${year}-0${between(3, 5)}-${String(between(10, 28)).padStart(2, '0')}`,
          ecacStatus: ecac,
          ...(ecac === 'refund_lot' || (ecac === 'processed' && refund) ? { refundLotDate: `${year}-0${between(6, 9)}-30` } : {}),
          ...(ecac === 'processed' && refund && year < 2026 ? { refundPaidAt: `${year}-09-30` } : {}),
        });
        if (year === 2024 || plan === 'finished') await owner.patch(`/api/declarations/${decl.id}/substatus`, { substatus: 'finished' });
        if (cents && year === 2026) taxDue.push({ person: p, declarationId: decl.id, cents });
      } else if (plan !== 'not_started') {
        if (cents || refund) await owner.put(`/api/customers/${p.id}/declarations/${year}`, { taxDueCents: cents, refundCents: refund });
        await owner.patch(`/api/declarations/${decl.id}/substatus`, { substatus: plan });
      }
    }
  }
  log('declarações de 2024, 2025 e 2026 com linhas da DIRPF');

  // ---------------------------------------------------------------- orçamentos e faturamento
  let publicBudgetLink = '';
  const budgetPlan: { status: 'draft' | 'sent' | 'approved' | 'rejected' | 'paid' | 'partial'; amount: number; installments: number; method: string; start: string }[] = [
    { status: 'paid', amount: 450, installments: 1, method: pix, start: '2026-03-05' },
    { status: 'partial', amount: 900, installments: 3, method: boleto, start: '2026-04-10' },
    { status: 'approved', amount: 600, installments: 2, method: card, start: '2026-09-15' },
    { status: 'sent', amount: 380, installments: 1, method: pix, start: '2026-10-20' },
    { status: 'draft', amount: 520, installments: 2, method: boleto, start: '2026-11-05' },
    { status: 'rejected', amount: 1200, installments: 4, method: card, start: '2026-04-01' },
  ];
  let budgetCount = 0;
  for (const p of people.slice(0, 24)) {
    const plan = budgetPlan[p.index % budgetPlan.length];
    if (!p.email && (plan.status === 'sent')) continue;
    for (const year of [2025, 2026]) {
      if (year === 2025 && p.index % 2 === 1) continue;
      const status = year === 2025 ? 'paid' : plan.status;
      const start = year === 2025 ? plan.start.replace('2026', '2025') : plan.start;
      const budget = await owner.post<{ id: string }>('/api/finance/budgets', {
        customerId: p.id,
        exerciseYear: year,
        type: 'fixed',
        category: p.profile === 'empresario' && year === 2026 ? 'holding' : 'irpf',
        description: p.profile === 'empresario' && year === 2026 ? 'Declaração IRPF e estudo de holding familiar' : `Elaboração da declaração IRPF ${year}`,
        amountCents: reais(plan.amount * (year === 2025 ? 0.9 : 1)),
        discountPercent: p.index % 5 === 0 ? 10 : 0,
        paymentMethodId: plan.method,
        billingStartDate: start,
        installments: plan.installments,
        internalNote: p.index % 4 === 0 ? 'Cliente antigo — manter o desconto de fidelidade.' : null,
      });
      budgetCount++;
      if (status === 'sent') {
        const sent = await owner.post<{ link: string }>(`/api/finance/budgets/${budget.id}/send`, { channels: ['email'] });
        if (!publicBudgetLink) publicBudgetLink = sent.link;
      } else if (status === 'rejected') {
        await owner.post(`/api/finance/budgets/${budget.id}/send`, { channels: ['email'] });
        await owner.post(`/api/finance/budgets/${budget.id}/reject`);
      } else if (status !== 'draft') {
        await owner.post(`/api/finance/budgets/${budget.id}/approve`);
        const list = await owner.get<{ data: { id: string; billing: { installments: { id: string; dueDate: string }[] } | null }[] }>(
          `/api/finance/customers/${p.id}/budgets?year=${year}`,
        );
        const inst = list.data.find((b) => b.id === budget.id)?.billing?.installments ?? [];
        const toPay = status === 'paid' ? inst : status === 'partial' ? inst.slice(0, 1) : [];
        for (const i of toPay) {
          const paidAt = i.dueDate <= '2026-10-06' ? i.dueDate : '2026-10-01';
          await owner.post(`/api/finance/installments/${i.id}/receive`, { paidAt });
        }
        if (status === 'paid' && year === 2026 && toPay[0]) await owner.post(`/api/finance/installments/${toPay[0].id}/receipt`);
      }
    }
  }
  log(`${budgetCount} orçamentos (rascunho, enviados, aprovados com parcelas pagas e recusados)`);

  // ---------------------------------------------------------------- DARFs
  let darfCount = 0;
  for (const [n, t] of taxDue.entries()) {
    const quotas = t.cents >= reais(3_000) ? Math.min(6, Math.floor(t.cents / reais(1_000))) : 1;
    const gen = await owner.post<{ darfs: { id: string; dueDate: string }[] }>(`/api/declarations/${t.declarationId}/darfs/generate`, { quotas, firstDueDate: '2026-05-29' });
    darfCount += gen.darfs.length;
    for (const d of gen.darfs.filter((x) => x.dueDate <= '2026-09-30').slice(0, n % 2 === 0 ? 99 : 2)) {
      await owner.put(`/api/darfs/${d.id}`, { paidAt: d.dueDate });
    }
    if (gen.darfs[0]) await owner.upload(`/api/darfs/${gen.darfs[0].id}/file`, [{ name: `darf-quota-1.pdf`, data: pdf('DARF quota 1'), type: 'application/pdf' }]);
  }
  log(`${darfCount} quotas de DARF`);

  // ---------------------------------------------------------------- pendências (documentos faltantes)
  const missing = ['Informe de rendimentos do banco', 'Recibos do dentista', 'Escritura do imóvel comprado no ano', 'Extrato da corretora em 31/12', 'Comprovante das mensalidades escolares', 'Contrato do financiamento imobiliário'];
  let backlogCount = 0;
  for (const p of people.filter((x) => x.index % 12 === 5 || x.index % 12 === 3 || x.index % 12 === 4)) {
    const id = declIds[p.id][2026];
    for (let k = 0; k < 2 + (p.index % 3); k++) {
      const b = await owner.post<{ id: string }>(`/api/declarations/${id}/backlogs`, { description: missing[(p.index + k) % missing.length], dueDate: k === 0 ? '2026-09-20' : '2026-10-30' });
      backlogCount++;
      if (k === 2) await owner.put(`/api/backlogs/${b.id}`, { resolved: true });
    }
  }
  log(`${backlogCount} documentos faltantes`);

  // ---------------------------------------------------------------- documentos
  for (const p of people.slice(0, 8)) {
    await owner.upload(`/api/customers/${p.id}/documents?year=2026`, [{ name: `Informe de rendimentos ${EMPLOYERS[p.index % EMPLOYERS.length]}.pdf`, data: pdf('informe'), type: 'application/pdf' }], { category: 'income_report' });
    await owner.upload(`/api/customers/${p.id}/documents?year=2026`, [{ name: 'Recibos médicos.pdf', data: pdf('recibos'), type: 'application/pdf' }], { category: 'health' });
  }
  log('documentos enviados pelo escritório');

  // ---------------------------------------------------------------- checklist, portal e mensagens
  const checklistPerson = people[4];
  const checklist = await owner.post<{ checklist?: { id: string }; id?: string }>(`/api/customers/${checklistPerson.id}/checklist`, { year: 2026 });
  const checklistId = (checklist.checklist?.id ?? checklist.id)!;
  const access = await owner.post<{ link: string; code: string }>(`/api/checklists/${checklistId}/access`, { channels: ['email'] });
  log('checklist digital criado e enviado');

  const portal = await owner.post<{ code?: string }>(`/api/customers/${checklistPerson.id}/portal-access`);
  const portalCode = portal.code ?? '';
  if (portalCode) {
    const login = await anon.post<{ token: string }>('/api/portal/login', { cpf: checklistPerson.cpf, code: portalCode });
    const customer = client(app, login.token);
    await owner.post(`/api/customers/${checklistPerson.id}/messages`, { body: 'Olá! Já liberamos o checklist da sua declaração 2026. Qualquer dúvida, escreva por aqui.' });
    await customer.post('/api/portal/messages', { body: 'Obrigada! O informe do banco ainda não saiu, posso mandar semana que vem?' });
    await owner.post(`/api/customers/${checklistPerson.id}/messages`, { body: 'Pode sim. Assim que chegar, envie pelo checklist mesmo.' });
    await customer.post('/api/portal/messages', { body: 'Combinado, muito obrigada!' });
  }
  for (const p of people.slice(1, 4)) {
    await owner.post(`/api/customers/${p.id}/messages`, { body: `Olá, ${p.name.split(' ')[0]}! Sua declaração ${2026} está em andamento. Avisaremos quando for transmitida.` });
  }
  log('portal do cliente e mensagens');

  // ---------------------------------------------------------------- eCAC (registros manuais)
  for (const p of people.filter((x) => x.index % 3 === 0).slice(0, 6)) {
    await owner.post(`/api/customers/${p.id}/ecac/records`, { kind: 'procuration', data: { status: 'valid', expiresAt: '2027-02-28', govbrLevel: 'gold' } });
    await owner.post(`/api/customers/${p.id}/ecac/records`, { kind: 'mailbox_message', externalId: `msg-${p.index}`, data: { subject: 'Aviso: declaração retida em malha fiscal', receivedAt: '2026-08-14', read: p.index % 2 === 0 } });
  }
  log('registros do eCAC');

  // ---------------------------------------------------------------- consultoria
  const empresario = people.find((p) => p.profile === 'empresario')!;
  await owner.post(`/api/customers/${empresario.id}/irpfm`, { year: 2026 });
  await owner.post('/api/copilot/enrollments', { customerId: empresario.id });
  for (const [m, amount] of [[7, 32_000], [8, 29_500], [9, 34_200]] as const) {
    await owner.post(`/api/customers/${empresario.id}/copilot/entries`, { kind: 'income', year: 2026, month: m, category: 'dividends', description: 'Distribuição de lucros', amountCents: reais(amount) });
    await owner.post(`/api/customers/${empresario.id}/copilot/entries`, { kind: 'expense', year: 2026, month: m, description: 'Despesas da casa', amountCents: reais(amount * 0.45) });
  }
  log('IRPFM e Copiloto');

  // ---------------------------------------------------------------- templates de e-mail
  const tpl = await owner.get<{ subject: string; body: string }>('/api/email-templates/budget');
  await owner.put('/api/email-templates/budget', { subject: `${tpl.subject} — Rangel & Associados`, body: `${tpl.body}<p>Atenciosamente,<br>Equipe Rangel &amp; Associados</p>` });
  log('template de orçamento personalizado');

  // ---------------------------------------------------------------- Radar (job real)
  await owner.post('/api/radar/refresh', { year: 2026 });
  await owner.post('/api/radar/refresh', { year: 2025 }).catch(() => null);
  await ctx.jobs.drain(500);
  const opps = await owner.get<{ data?: { id: string }[] } | { id: string }[]>('/api/radar/opportunities?year=2026');
  const oppList = Array.isArray(opps) ? opps : (opps.data ?? []);
  if (oppList[0]) await owner.put(`/api/radar/opportunities/${oppList[0].id}`, { status: 'in_progress' });
  if (oppList[1]) await owner.put(`/api/radar/opportunities/${oppList[1].id}`, { status: 'done' });
  log(`Radar processado (${oppList.length} oportunidades em 2026)`);

  await ctx.jobs.drain(500);
  await finish();

  console.log('\nEscritório de demonstração pronto.');
  console.log(`  Dono:          ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Colaboradores: bruno.teixeira@verifco.dev e carla.menezes@verifco.dev / ${STAFF_PASSWORD}`);
  if (portalCode) console.log(`  Portal:        CPF ${checklistPerson.cpf} · código ${portalCode} (${checklistPerson.name})`);
  console.log(`  Checklist:     ${access.link} · código ${access.code}`);
  if (publicBudgetLink) console.log(`  Orçamento:     ${publicBudgetLink}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
