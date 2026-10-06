import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import type { AppContext } from '../src/context';
import { MemoryProviders } from '../src/integrations/providers';

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  providers: MemoryProviders;
  close: () => Promise<void>;
}

/** Sobe a API com PGlite em memória, armazenamento em memória e provedores falsos. */
export async function createTestEnv(): Promise<TestEnv> {
  const providers = new MemoryProviders();
  const { ctx, close } = await createContext(
    { DATABASE_URL: 'pglite:memory', PLATFORM_DATABASE_URL: 'pglite:memory', NODE_ENV: 'test', RUN_WORKER: false },
    { providers, memoryStorage: true },
  );
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    providers,
    close: async () => {
      await app.close();
      await close();
    },
  };
}

let seq = 0;

/** Cria um escritório novo e devolve um cliente HTTP autenticado como o dono. */
export async function registerOffice(env: TestEnv, name = 'Escritório Teste') {
  seq += 1;
  const email = `dono${seq}-${Date.now()}@teste.com.br`;
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { officeName: name, name: 'Ana Dona', email, password: 'senha-forte-123' },
  });
  if (res.statusCode !== 201) throw new Error(`registro falhou: ${res.body}`);
  const body = res.json();
  return { token: body.token as string, officeId: body.office.id as string, userId: body.user.id as string, email, api: client(env, body.token) };
}

export function client(env: TestEnv, token: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await env.app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, body: json, raw: res };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}

export type Api = ReturnType<typeof client>;

/** Cria um colaborador com as permissões dadas, define a senha e devolve o cliente dele. */
export async function createEmployee(env: TestEnv, owner: Api, permissions: string[]) {
  const role = await owner.post('/api/roles', { name: `Função ${Math.random().toString(36).slice(2, 8)}`, permissions });
  const email = `colab-${Math.random().toString(36).slice(2, 10)}@teste.com.br`;
  const emp = await owner.post('/api/employees', { name: 'Colaborador', email, roleId: role.body.id });
  const token = new URL(emp.body.inviteLink).searchParams.get('token');
  await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'senha-colab-123' } });
  const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'senha-colab-123' } });
  return { api: client(env, login.json().token), userId: emp.body.id as string, roleId: role.body.id as string };
}

export const VALID_CPFS = ['52998224725', '11144477735', '39053344705', '01234567890', '12345678909', '98765432100', '11122233396', '22233344405'];
