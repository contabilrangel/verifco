/** Apoio aos testes de cobrança: `fetch` simulado e um Asaas em memória (cobranças com estado). */
import type { TestEnv } from './helpers';

export type Reply = { status?: number; json?: unknown };
export interface Call {
  url: string;
  path: string;
  method: string;
  body: any;
}

export function mockFetch(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call = { url, path: new URL(url).pathname.replace(/^\/v3/, ''), method: init?.method ?? 'GET', body };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

export interface FakePayment {
  id: string;
  status: string;
  deleted: boolean;
  billingType: string;
  value: number;
  dueDate: string;
  invoiceUrl: string;
  externalReference?: string;
  paymentDate?: string;
}

/**
 * Asaas simulado: cria cobranças, consulta, altera, remove, recebe em dinheiro e desfaz, guardando o
 * estado de cada uma. `failNext(teste, resposta)` faz a próxima chamada que casar falhar.
 */
export function fakeAsaas() {
  const payments = new Map<string, FakePayment>();
  let seq = 0;
  let failing: { match: (c: Call) => boolean; reply: Reply; once: boolean } | null = null;
  const m = mockFetch((c) => {
    if (failing?.match(c)) {
      const r = failing.reply;
      if (failing.once) failing = null;
      return r;
    }
    if (c.path === '/customers' && c.method === 'GET') return { json: { data: [] } };
    if (c.path === '/customers' && c.method === 'POST') return { json: { id: 'cus_1', name: c.body.name } };
    if (c.path.startsWith('/customers/') && c.method === 'PUT') return { json: { id: 'cus_1' } };
    if (c.path === '/payments' && c.method === 'GET') return { json: { data: [] } };
    if (c.path === '/payments' && c.method === 'POST') {
      seq += 1;
      const p: FakePayment = { id: `pay_${seq}`, status: 'PENDING', deleted: false, billingType: c.body.billingType, value: c.body.value, dueDate: c.body.dueDate, invoiceUrl: `https://sandbox.asaas.com/i/${seq}`, externalReference: c.body.externalReference };
      payments.set(p.id, p);
      return { json: p };
    }
    const hit = /^\/payments\/([^/]+)(?:\/(\w+))?$/.exec(c.path);
    const p = hit ? payments.get(hit[1]) : undefined;
    if (!hit || !p) return { status: 404, json: { errors: [{ description: 'Cobrança não encontrada.' }] } };
    const action = hit[2];
    if (!action && c.method === 'GET') return { json: p };
    if (!action && c.method === 'PUT') {
      Object.assign(p, { value: c.body.value ?? p.value, dueDate: c.body.dueDate ?? p.dueDate });
      return { json: p };
    }
    if (!action && c.method === 'DELETE') {
      if (p.status !== 'PENDING' && p.status !== 'OVERDUE') return { status: 400, json: { errors: [{ description: 'Só é possível remover cobranças pendentes ou vencidas.' }] } };
      p.deleted = true;
      return { json: { deleted: true, id: p.id } };
    }
    if (action === 'receiveInCash' && c.method === 'POST') {
      Object.assign(p, { status: 'RECEIVED_IN_CASH', value: c.body.value, paymentDate: c.body.paymentDate });
      return { json: p };
    }
    if (action === 'undoReceivedInCash' && c.method === 'POST') {
      if (p.status !== 'RECEIVED_IN_CASH') return { status: 400, json: { errors: [{ description: 'A cobrança não foi recebida em dinheiro.' }] } };
      p.status = 'PENDING';
      return { json: p };
    }
    return { status: 404, json: { errors: [{ description: 'rota inesperada' }] } };
  });
  return {
    ...m,
    payments,
    /** Cobranças na ordem em que foram criadas. */
    list: () => [...payments.values()],
    failNext(match: (c: Call) => boolean, reply: Reply, once = true) {
      failing = { match, reply, once };
    },
    /** Chamadas feitas depois da marca (para conferir só o que um passo do teste disparou). */
    since: (mark: number) => m.calls.slice(mark).map((c) => `${c.method} ${c.path}`),
  };
}

export const ASAAS_ON = { enabled: true, config: { environment: 'sandbox' }, secrets: { apiKey: '$aact_hmlg_abc123456789' } };

/** E-mails de cobrança (template `charge`) enviados a um destinatário. */
export const chargeMails = (env: TestEnv, to: string) => env.providers.sentEmails.filter((m) => m.to === to && m.subject.startsWith('Cobrança dos honorários'));
