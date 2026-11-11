/**
 * Selic mensal do Banco Central (série 4390 do SGS): leitura da resposta, gravação dos meses
 * fechados, consulta "banco primeiro, tabela fixa depois" e tolerância a falhas de rede.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { SELIC_MONTHLY_PERCENT, darfQuotaAmount, darfValueText } from '@verifco/shared';
import { customers, darfs, declarations, jobs, taxIndices } from '../src/db/schema';
import { SELIC_JOB, SELIC_SERIES_URL, ensureSelicSchedule, nextSelicRun, parseSelicSeries, refreshSelic, scheduleSelicRefresh, selicTable } from '../src/services/indices';
import { VALID_CPFS, createTestEnv, registerOffice, type TestEnv } from './helpers';

let env: TestEnv;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(() => {
  env.providers.fetch = realFetch;
});

const TODAY = '2026-11-10';
/** Resposta do SGS: meses de 2026 (jan a set iguais à tabela fixa), outubro fechado e novembro em curso. */
const series = (october = '1.28') => [
  ...Object.entries(SELIC_MONTHLY_PERCENT)
    .filter(([period]) => period.startsWith('2026'))
    .map(([period, value]) => ({ data: `01/${period.slice(5)}/${period.slice(0, 4)}`, valor: String(value) })),
  { data: '01/10/2026', valor: october },
  { data: '01/11/2026', valor: '0.31' },
];

/** `fetch` falso que devolve o corpo dado e guarda as chamadas. */
function bcb(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stored = () => env.ctx.db.select().from(taxIndices).where(eq(taxIndices.code, 'selic')).orderBy(asc(taxIndices.period));

describe('leitura da série do Banco Central', () => {
  it('fica só com os meses fechados e ignora o que foge do formato', () => {
    const months = parseSelicSeries(series(), TODAY);
    expect(months).toHaveLength(10);
    expect(months[0]).toEqual({ period: '2026-01', value: 1.16 });
    expect(months.at(-1)).toEqual({ period: '2026-10', value: 1.28 });
    // o mês em curso (acumulado até o dia) não entra; no dia 1º do mês seguinte, entra
    expect(months.some((m) => m.period === '2026-11')).toBe(false);
    expect(parseSelicSeries(series(), '2026-12-01').at(-1)).toEqual({ period: '2026-11', value: 0.31 });

    expect(
      parseSelicSeries(
        [
          { data: '01/10/2026', valor: '1,28' },
          { data: '2026-09-01', valor: '1.08' },
          { data: '01/13/2026', valor: '1.00' },
          { data: '01/08/2026', valor: 'n/d' },
          { data: '01/07/2026', valor: '' },
          { data: '01/06/2026', valor: '-0.5' },
          { data: '01/05/2026', valor: '1280' },
          { data: '01/04/2026' },
          { valor: '1.09' },
          null,
          'texto',
          { data: '01/03/2026', valor: 1.21 },
        ],
        TODAY,
      ),
    ).toEqual([
      { period: '2026-03', value: 1.21 },
      { period: '2026-10', value: 1.28 },
    ]);
    // resposta que não é a lista esperada
    for (const bad of [null, undefined, '', 'erro', {}, { erro: 'x' }, 42]) expect(parseSelicSeries(bad, TODAY)).toEqual([]);
  });
});

describe('atualização da Selic', () => {
  it('busca com prazo, grava os meses fechados e atualiza o que mudou sem duplicar', async () => {
    const api = bcb(() => json(series()));
    env.providers.fetch = api.fn;
    expect(await refreshSelic(env.ctx, { today: TODAY })).toEqual({ ok: true, months: 10, latest: '2026-10' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toBe(SELIC_SERIES_URL);
    expect(api.calls[0].url).toContain('bcdata.sgs.4390');
    // a consulta tem prazo: uma resposta que não chega não prende o job
    expect(api.calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    let rows = await stored();
    expect(rows.map((r) => r.period)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(rows.at(-1)).toMatchObject({ code: 'selic', period: '2026-10', value: '1.28' });

    // o Banco Central revisou outubro: o mês é atualizado, sem linha nova
    env.providers.fetch = bcb(() => json(series('1.30'))).fn;
    expect(await refreshSelic(env.ctx, { today: TODAY })).toMatchObject({ ok: true, months: 10 });
    rows = await stored();
    expect(rows).toHaveLength(10);
    expect(rows.at(-1)!.value).toBe('1.3');
    env.providers.fetch = bcb(() => json(series())).fn;
    await refreshSelic(env.ctx, { today: TODAY });
    expect((await stored()).at(-1)!.value).toBe('1.28');
  });

  it('falha de rede, erro do servidor ou resposta estranha não lançam nem apagam o que já existe', async () => {
    const before = await stored();
    expect(before).toHaveLength(10);
    const failures: [string, () => Response | Promise<Response>, RegExp][] = [
      ['rede', () => Promise.reject(new TypeError('fetch failed')), /fetch failed/],
      ['prazo', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), /timeout/],
      ['HTTP 502', () => json({ erro: 'indisponível' }, 502), /HTTP 502/],
      ['não é JSON', () => new Response('<html>manutenção</html>', { status: 200 }), /./],
      ['sem lista', () => json({ mensagem: 'sem dados' }), /sem meses reconhecidos/],
      ['lista vazia', () => json([]), /sem meses reconhecidos/],
    ];
    for (const [name, reply, message] of failures) {
      env.providers.fetch = bcb(reply).fn;
      const res = await refreshSelic(env.ctx, { today: TODAY });
      expect(res.ok, name).toBe(false);
      expect((res as { error: string }).error, name).toMatch(message);
    }
    expect(await stored()).toEqual(before);
  });

  it('a consulta lê o banco primeiro e a tabela fixa depois; mês sem taxa continua sem taxa', async () => {
    const table = await selicTable(env.ctx.db);
    expect(table['2026-10']).toBe(1.28);
    expect(SELIC_MONTHLY_PERCENT['2026-10']).toBeUndefined();
    // quota 7 que vence em novembro: junho a outubro; só o banco tem outubro
    const quota = { quotaNumber: 7, principalCents: 100_000, dueDate: '2026-11-30' };
    expect(darfQuotaAmount(quota)).toMatchObject({ totalCents: null, missingSelicMonths: ['2026-10'] });
    // 1,12 + 1,22 + 1,09 + 1,08 + 1,28 = 5,79% + 1%
    expect(darfQuotaAmount({ ...quota, extraSelic: table })).toMatchObject({ missingSelicMonths: [], interestPercent: 6.79, interestCents: 6_790, totalCents: 106_790 });
    // o valor do banco vale antes do da tabela fixa
    expect(darfQuotaAmount({ quotaNumber: 3, principalCents: 100_000, dueDate: '2026-07-31', extraSelic: { '2026-06': 2 } })).toMatchObject({ interestPercent: 3, totalCents: 103_000 });
    // mês que nenhuma das duas tem (novembro em curso): nada é estimado
    expect(darfQuotaAmount({ quotaNumber: 8, principalCents: 100_000, dueDate: '2026-12-30', extraSelic: table })).toMatchObject({ totalCents: null, missingSelicMonths: ['2026-11'] });
    // meses anteriores ao que o banco tem continuam vindo da tabela fixa
    expect(darfQuotaAmount({ quotaNumber: 3, principalCents: 100_000, dueDate: '2025-07-31', extraSelic: table })).toMatchObject({ interestPercent: 2.1, totalCents: 102_100 });

    // em memória por uma hora: uma linha gravada por fora só aparece depois (ou após uma atualização)
    await env.ctx.db.insert(taxIndices).values({ code: 'selic', period: '2023-12', value: '0.89' });
    await env.ctx.db.insert(taxIndices).values({ code: 'outro', period: '2023-11', value: '9.99' });
    expect((await selicTable(env.ctx.db))['2023-12']).toBeUndefined();
    const later = await selicTable(env.ctx.db, Date.now() + 61 * 60_000);
    expect(later['2023-12']).toBe(0.89);
    // só o índice `selic`
    expect(later['2023-11']).toBeUndefined();
  });

  it('a etapa DARF e o e-mail da guia usam o mês que só o banco tem', async () => {
    const { api, officeId } = await registerOffice(env);
    const c = await api.post('/api/customers', { name: 'Quota Sete', cpfCnpj: VALID_CPFS[0], email: 'quota@ex.com' });
    const [decl] = await env.ctx.db.insert(declarations).values({ officeId, customerId: c.body.id, exerciseYear: 2026, taxDueCents: 800_000 }).returning();
    const [q7, q8] = await env.ctx.db
      .insert(darfs)
      .values([
        { officeId, customerId: c.body.id, declarationId: decl.id, quotaNumber: 7, valueCents: 100_000, dueDate: '2026-11-30', source: 'generated' },
        { officeId, customerId: c.body.id, declarationId: decl.id, quotaNumber: 8, valueCents: 100_000, dueDate: '2026-12-30', source: 'generated' },
      ])
      .returning();
    const list = (await api.get(`/api/declarations/${decl.id}/darfs`)).body.darfs;
    expect(list.find((d: any) => d.id === q7.id).amount).toMatchObject({ principalCents: 100_000, interestPercent: 6.79, totalCents: 106_790 });
    // a 8ª depende de novembro, que ainda não fechou: só o principal, com o aviso
    expect(list.find((d: any) => d.id === q8.id).amount).toMatchObject({ totalCents: null, interestPercent: null });
    expect(list.find((d: any) => d.id === q8.id).amount.note).toMatch(/a taxa de nov\/2026 ainda não foi publicada/);
    expect(darfValueText(q7, await selicTable(env.ctx.db))).toMatch(/^R\$\s1\.067,90 \(principal de R\$\s1\.000,00 \+ juros de 6,79%: Selic acumulada \+ 1%\)$/);
    expect((await env.ctx.db.select().from(customers).where(eq(customers.id, c.body.id)))[0].email).toBe('quota@ex.com');
  });
});

describe('job semanal', () => {
  const selicJobs = () => env.ctx.db.select().from(jobs).where(eq(jobs.type, SELIC_JOB)).orderBy(asc(jobs.runAt));

  it('toda segunda-feira às 6h de Brasília, uma na fila, com chave pelo dia', async () => {
    // terça 10/11/2026, 10h de Brasília → segunda 16/11 às 6h (9h UTC)
    expect(nextSelicRun(new Date('2026-11-10T13:00:00Z')).toISOString()).toBe('2026-11-16T09:00:00.000Z');
    // segunda antes das 6h: hoje; depois das 6h: a próxima
    expect(nextSelicRun(new Date('2026-11-16T08:00:00Z')).toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(nextSelicRun(new Date('2026-11-16T09:30:00Z')).toISOString()).toBe('2026-11-23T09:00:00.000Z');
    expect(nextSelicRun(new Date('2026-11-16T08:00:00Z'), '2026-11-16').toISOString()).toBe('2026-11-23T09:00:00.000Z');

    const job = (await scheduleSelicRefresh(env.ctx))!;
    expect(job).toMatchObject({ status: 'queued', officeId: null, maxAttempts: 1, idempotencyKey: `selic:${job.payload.day}` });
    expect((await scheduleSelicRefresh(env.ctx))!.id).toBe(job.id);
    expect(await selicJobs()).toHaveLength(1);
    // já há meses gravados: ao subir, não pede a busca inicial
    await ensureSelicSchedule(env.ctx);
    expect(await selicJobs()).toHaveLength(1);
  });

  it('roda, reagenda a semana seguinte e termina bem mesmo sem rede', async () => {
    const [job] = await selicJobs();
    const api = bcb(() => Promise.reject(new TypeError('fetch failed')));
    env.providers.fetch = api.fn;
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));
    await env.ctx.jobs.drain();
    expect(api.calls).toHaveLength(1);
    let rows = await selicJobs();
    expect(rows).toHaveLength(2);
    // sem rede o job não falha: registra e a rodada da semana seguinte tenta de novo
    expect(rows[0]).toMatchObject({ id: job.id, status: 'done', error: null, result: { ok: false, error: 'fetch failed' } });
    expect(rows[1]).toMatchObject({ status: 'queued' });
    expect(rows[1].runAt.getTime() - job.runAt.getTime()).toBe(7 * 86_400_000);
    expect(await stored()).toHaveLength(11);

    // na semana seguinte, com a rede de volta, grava
    env.providers.fetch = bcb(() => json([...series(), { data: '01/12/2023', valor: '0.90' }])).fn;
    await env.ctx.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, rows[1].id));
    await env.ctx.jobs.drain();
    rows = await selicJobs();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === job.id)!.status).toBe('done');
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
    const second = (await env.ctx.db.query.jobs.findFirst({ where: and(eq(jobs.type, SELIC_JOB), eq(jobs.status, 'done'), eq(jobs.idempotencyKey, rows[1].idempotencyKey!)) }))!;
    expect(second.result).toMatchObject({ ok: true });
    expect((await stored()).find((r) => r.period === '2023-12')!.value).toBe('0.9');
  });

  it('instalação nova (nenhum mês gravado): pede a busca inicial uma vez por dia', async () => {
    await env.ctx.db.delete(taxIndices);
    await ensureSelicSchedule(env.ctx);
    await ensureSelicSchedule(env.ctx);
    const first = (await selicJobs()).filter((j) => j.idempotencyKey?.startsWith('selic:inicial:'));
    expect(first).toHaveLength(1);
    env.providers.fetch = bcb(() => json(series())).fn;
    await env.ctx.jobs.drain();
    expect((await env.ctx.db.query.jobs.findFirst({ where: eq(jobs.id, first[0].id) }))!).toMatchObject({ status: 'done', result: { ok: true } });
    expect((await stored()).length).toBeGreaterThanOrEqual(10);
  });
});
