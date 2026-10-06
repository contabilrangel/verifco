import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkbook } from '../src/services/xlsx';
import { VALID_CPFS, createEmployee, createTestEnv, registerOffice, type Api, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());

/** Envia um arquivo como multipart/form-data. */
async function upload(token: string, url: string, filename: string, content: Buffer | string, contentType = 'text/csv') {
  const boundary = `----vf${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await env.app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() };
}

async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

const sheetRows = (ws: ExcelJS.Worksheet) => {
  const out: string[][] = [];
  ws.eachRow((row) => out.push((row.values as unknown[]).slice(1).map((v) => String(v ?? ''))));
  return out;
};

/** Token do colaborador criado por `createEmployee` (senha padrão do helper). */
async function employeeToken(owner: Api, userId: string) {
  const list = await owner.get('/api/employees');
  const email = list.body.find((u: any) => u.id === userId).email;
  const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'senha-colab-123' } });
  return res.json().token as string;
}

const byRow = (results: { row: number; ok: boolean; message: string }[]) => Object.fromEntries(results.map((r) => [r.row, r]));

describe('importação de novos clientes', () => {
  it('modelo traz as colunas, os colaboradores e os grupos', async () => {
    const office = await registerOffice(env);
    await office.api.post('/api/customer-groups', { name: 'VIP' });
    const res = await office.api.get('/api/imports/novos-clientes/template');
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-type']).toContain('spreadsheetml');
    const wb = await readXlsx(res.raw.rawPayload);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Clientes', 'Colaboradores', 'Grupos', 'Instruções']);
    expect(sheetRows(wb.worksheets[0])[0]).toEqual(['Nome', 'CPF', 'E-mail do responsável', 'E-mail', 'Celular', 'Telefone', 'Grupo', 'Data de nascimento']);
    expect(sheetRows(wb.getWorksheet('Colaboradores')!)[1]).toContain(office.email);
    expect(sheetRows(wb.getWorksheet('Grupos')!)[1]).toEqual(['VIP']);
  });

  it('processa linha a linha: erros não impedem as demais linhas', async () => {
    const office = await registerOffice(env);
    const vip = await office.api.post('/api/customer-groups', { name: 'VIP' });
    await office.api.post('/api/customers', { name: 'Já cadastrado', cpfCnpj: VALID_CPFS[0] });
    const resp = office.email;
    const csv = [
      'Nome;CPF;E-mail do responsável;E-mail;Celular;Telefone;Grupo;Data de nascimento',
      `Ana Lima;${VALID_CPFS[1]};${resp};ana@ex.com;(81) 99999-1234;;vip;15/03/1980`, // 2 ok
      `Bruno;123.456.789-00;${resp};;;;;`, // 3 CPF inválido
      `Carla;${VALID_CPFS[0]};${resp};;;;;`, // 4 CPF já cadastrado
      `Diego;${VALID_CPFS[2]};fulano@outro.com;;;;;`, // 5 responsável de fora
      `Ana Lima;${VALID_CPFS[1]};${resp};ana@ex.com;(81) 99999-1234;;vip;15/03/1980`, // 6 linha idêntica
      `Eva Souza;1234567890;${resp};;;;VIP;`, // 7 ok: Excel cortou o zero à esquerda
      `Fábio;${VALID_CPFS[4]};${resp};email-invalido;123;;Inexistente;31/02/1990`, // 8 vários erros
      `Gil;${VALID_CPFS[5]};${resp.toUpperCase()};;;;;`, // 9 ok
      `Gil Dois;${VALID_CPFS[5]};${resp};;;;;`, // 10 CPF repetido no arquivo
      `;${VALID_CPFS[6]};;;;;;`, // 11 sem nome e sem responsável
    ].join('\n');
    const res = await upload(office.token, '/api/imports/novos-clientes', 'clientes.csv', csv);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'novos-clientes', total: 10, succeeded: 3, failed: 7, status: 'partial', ignored: 0 });
    const r = byRow(res.body.results);
    expect(r[2]).toMatchObject({ ok: true, message: 'Cliente Ana Lima cadastrado.' });
    expect(r[3].message).toContain('inválido');
    expect(r[4].message).toContain('já está cadastrado');
    expect(r[5].message).toContain('não é colaborador');
    expect(r[6].message).toBe('Linha repetida: igual à linha 2.');
    expect(r[7].ok).toBe(true);
    expect(r[8].message).toContain('E-mail email-invalido inválido');
    expect(r[8].message).toContain('Celular 123 inválido');
    expect(r[8].message).toContain('Grupo “Inexistente” não existe');
    expect(r[8].message).toContain('Data de nascimento 31/02/1990 inválida');
    expect(r[9].ok).toBe(true);
    expect(r[10].message).toContain('repetido na planilha (já aparece na linha 9)');
    expect(r[11].message).toContain('Informe o nome');
    expect(r[11].message).toContain('Informe o e-mail do responsável');

    const list = await office.api.get('/api/customers?pageSize=50');
    expect(list.body.total).toBe(4);
    const ana = list.body.data.find((c: any) => c.name === 'Ana Lima');
    expect(ana).toMatchObject({ email: 'ana@ex.com', mobile: '81999991234', birthDate: '1980-03-15', responsibleUserId: office.userId });
    expect(ana.groups).toEqual([{ id: vip.body.id, name: 'VIP' }]);
    expect(list.body.data.find((c: any) => c.name === 'Eva Souza').cpfCnpj).toBe('01234567890');

    // o arquivo fica guardado para consulta
    const batch = await office.api.get(`/api/imports/${res.body.id}`);
    expect(batch.body.fileId).toBeTruthy();
    expect(batch.body.filename).toBe('clientes.csv');
    expect(batch.body.results).toHaveLength(10);
  });

  it('aceita .xlsx e CSV salvo pelo Excel em Windows-1252', async () => {
    const office = await registerOffice(env);
    const xlsx = await buildWorkbook([
      {
        name: 'Clientes',
        columns: [
          { header: 'Nome', key: 'name' },
          { header: 'CPF', key: 'cpf' },
          { header: 'E-mail do responsável', key: 'resp' },
        ],
        rows: [{ name: 'Helena', cpf: '529.982.247-25', resp: office.email }],
      },
    ]);
    const a = await upload(office.token, '/api/imports/novos-clientes', 'clientes.xlsx', xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(a.body).toMatchObject({ total: 1, succeeded: 1, status: 'done' });

    const latin1 = Buffer.from(`Nome;CPF;E-mail do responsável\nJosé Ávila;${VALID_CPFS[1]};${office.email}\n`, 'latin1');
    const b = await upload(office.token, '/api/imports/novos-clientes', 'clientes.csv', latin1);
    expect(b.body.succeeded).toBe(1);
    const list = await office.api.get('/api/customers?search=Jos');
    expect(list.body.data[0].name).toBe('José Ávila');
  });

  it('recusa arquivo vazio, formato errado, modelo trocado e mais de 5.000 linhas', async () => {
    const office = await registerOffice(env);
    const url = '/api/imports/novos-clientes';
    expect((await upload(office.token, url, 'clientes.txt', 'Nome;CPF\nA;1')).status).toBe(400);
    expect((await upload(office.token, url, 'clientes.csv', 'Nome;CPF;E-mail do responsável\n')).status).toBe(400);
    const wrong = await upload(office.token, url, 'clientes.csv', 'Produto;Valor\nCaneta;10\n');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('Nome');
    const big = ['Nome;CPF;E-mail do responsável', ...Array.from({ length: 5001 }, (_, i) => `Cliente ${i};${VALID_CPFS[0]};${office.email}`)].join('\n');
    const res = await upload(office.token, url, 'grande.csv', big);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('5.000');
    expect((await office.api.get('/api/imports')).body.total).toBe(0);
  });
});

describe('importações de atualização', () => {
  it('atualiza telefone, celular e e-mail pelo CPF', async () => {
    const office = await registerOffice(env);
    const a = await office.api.post('/api/customers', { name: 'Alice', cpfCnpj: VALID_CPFS[0], email: 'old@ex.com' });
    await office.api.post('/api/customers', { name: 'Bento', cpfCnpj: VALID_CPFS[1] });
    await office.api.post('/api/customers', { name: 'Cora', cpfCnpj: VALID_CPFS[2], email: 'cora@ex.com' });

    const tpl = await office.api.get('/api/imports/atualizar-clientes/template');
    const rows = sheetRows((await readXlsx(tpl.raw.rawPayload)).worksheets[0]);
    expect(rows[0]).toEqual(['Nome', 'CPF', 'E-mail', 'Celular', 'Telefone']);
    expect(rows[1]).toEqual(['Alice', '529.982.247-25', 'old@ex.com', '', '']);

    const csv = [
      'Nome;CPF;E-mail;Celular;Telefone',
      'Alice;529.982.247-25;novo@ex.com;+55 11 98888-7777;', // 2 atualiza e-mail e celular
      `Bento;${VALID_CPFS[1]};;;`, // 3 sem dados: ignorada
      `Cora;${VALID_CPFS[2]};cora@ex.com;;`, // 4 sem alteração: ignorada
      `Xavier;${VALID_CPFS[3]};x@ex.com;;`, // 5 não é cliente
      `Bento;${VALID_CPFS[1]};bento@;;`, // 6 e-mail inválido
    ].join('\n');
    const res = await upload(office.token, '/api/imports/atualizar-clientes', 'contatos.csv', csv);
    expect(res.body).toMatchObject({ total: 3, succeeded: 1, failed: 2, ignored: 2 });
    const r = byRow(res.body.results);
    expect(r[2].message).toBe('Alice: e-mail, celular atualizado(s).');
    expect(r[5].message).toContain('não encontrado');
    expect(r[6].message).toContain('inválido');
    const got = await office.api.get(`/api/customers/${a.body.id}`);
    expect(got.body).toMatchObject({ email: 'novo@ex.com', mobile: '11988887777' });
  });

  it('associa procurador e marca a procuração para validação', async () => {
    const office = await registerOffice(env);
    const p = await office.api.post('/api/procurators', { name: 'Contábil Ltda', cpfCnpj: '11.222.333/0001-81' });
    const a = await office.api.post('/api/customers', { name: 'Alice', cpfCnpj: VALID_CPFS[0] });
    await office.api.post('/api/customers', { name: 'Bento', cpfCnpj: VALID_CPFS[1] });
    await office.api.post('/api/customers', { name: 'Cora', cpfCnpj: VALID_CPFS[2] });

    const csv = [
      'Nome;CPF;CPF/CNPJ do procurador;Situação da procuração',
      `Alice;${VALID_CPFS[0]};11222333000181;Sem procurador`, // ok
      `Bento;${VALID_CPFS[1]};11.444.777/0001-61;Sem procurador`, // procurador não cadastrado
      `Cora;${VALID_CPFS[2]};;Sem procurador`, // ignorada
    ].join('\n');
    const res = await upload(office.token, '/api/imports/procuracoes', 'procuracoes.csv', csv);
    expect(res.body).toMatchObject({ total: 2, succeeded: 1, failed: 1, ignored: 1 });
    expect(byRow(res.body.results)[3].message).toContain('não está cadastrado');
    const got = await office.api.get(`/api/customers/${a.body.id}`);
    expect(got.body.procurator.id).toBe(p.body.id);
    expect(got.body.procurationStatus).toBe('validating');

    // o modelo passa a trazer o procurador atual; reenviar não muda nada
    const tpl = await office.api.get('/api/imports/procuracoes/template');
    const rows = sheetRows((await readXlsx(tpl.raw.rawPayload)).worksheets[0]);
    expect(rows[1]).toEqual(['Alice', '529.982.247-25', '11.222.333/0001-81', 'Aguardando validação']);
    const again = await upload(office.token, '/api/imports/procuracoes', 'p.csv', `CPF;CPF/CNPJ do procurador\n${VALID_CPFS[0]};11.222.333/0001-81`);
    expect(again.body).toMatchObject({ total: 0, ignored: 1 });
  });

  it('INSS e eCAC: senhas cifradas, nunca devolvidas e arquivo não guardado', async () => {
    const office = await registerOffice(env);
    const a = await office.api.post('/api/customers', { name: 'Alice', cpfCnpj: VALID_CPFS[0] });
    const b = await office.api.post('/api/customers', { name: 'Bento', cpfCnpj: VALID_CPFS[1] });

    const inss = await upload(
      office.token,
      '/api/imports/inss',
      'inss.csv',
      `Nome;CPF;Senha gov.br;Senha já cadastrada\nAlice;${VALID_CPFS[0]};segredo-inss-1;Não\nBento;${VALID_CPFS[1]};;Não`,
    );
    expect(inss.body).toMatchObject({ total: 1, succeeded: 1, ignored: 1, fileId: null });
    expect(JSON.stringify(inss.body)).not.toContain('segredo-inss-1');

    const ecac = await upload(
      office.token,
      '/api/imports/ecac',
      'ecac.csv',
      `Nome;CPF;Login;Senha\nAlice;${VALID_CPFS[0]};;senha-ecac-1\nBento;${VALID_CPFS[1]};loginbento;`,
    );
    expect(ecac.body).toMatchObject({ total: 2, succeeded: 1, failed: 1, fileId: null });
    expect(byRow(ecac.body.results)[3].message).toBe('Informe a senha.');

    const row = await env.ctx.db.query.customers.findFirst({ where: (t, { eq }) => eq(t.id, a.body.id) });
    expect(env.ctx.secrets.decrypt(row!.inssPasswordEnc!)).toBe('segredo-inss-1');
    expect(env.ctx.secrets.decrypt(row!.ecacLoginEnc!)).toBe(VALID_CPFS[0]);
    expect(env.ctx.secrets.decrypt(row!.ecacPasswordEnc!)).toBe('senha-ecac-1');
    const pub = await office.api.get(`/api/customers/${a.body.id}`);
    expect(pub.body).toMatchObject({ hasInssPassword: true, hasEcacCredentials: true });
    expect(JSON.stringify(pub.body)).not.toContain('senha-ecac-1');
    expect((await office.api.get(`/api/customers/${b.body.id}`)).body.hasEcacCredentials).toBe(false);

    const tpl = await office.api.get('/api/imports/inss/template');
    const rows = sheetRows((await readXlsx(tpl.raw.rawPayload)).worksheets[0]);
    expect(rows[1]).toEqual(['Alice', '529.982.247-25', '', 'Sim']);
    expect(tpl.raw.rawPayload.toString('latin1')).not.toContain('segredo-inss-1');
  });

  it('respeita a restrição de clientes por responsável', async () => {
    const office = await registerOffice(env);
    const emp = await createEmployee(env, office.api, ['worksheet.update_customers', 'customer.list']);
    await office.api.post('/api/customers', { name: 'Do dono', cpfCnpj: VALID_CPFS[0] });
    await office.api.post('/api/customers', { name: 'Do colaborador', cpfCnpj: VALID_CPFS[1], responsibleUserId: emp.userId });
    await office.api.put('/api/office/settings', { restrictCustomersToResponsible: true });
    const tpl = await emp.api.get('/api/imports/atualizar-clientes/template');
    const rows = sheetRows((await readXlsx(tpl.raw.rawPayload)).worksheets[0]);
    expect(rows.map((r) => r[0])).toEqual(['Nome', 'Do colaborador']);

    const token = await employeeToken(office.api, emp.userId);
    const res = await upload(token, '/api/imports/atualizar-clientes', 'u.csv', `CPF;E-mail\n${VALID_CPFS[0]};x@ex.com\n${VALID_CPFS[1]};y@ex.com`);
    expect(res.body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(res.body.results[0].message).toContain('não encontrado');
  });
});

describe('histórico, permissões e isolamento', () => {
  it('lista o histórico por tipo, com detalhe e relatório', async () => {
    const office = await registerOffice(env);
    const csv = (cpf: string) => `Nome;CPF;E-mail do responsável\nCliente ${cpf};${cpf};${office.email}`;
    const first = await upload(office.token, '/api/imports/novos-clientes', 'a.csv', csv(VALID_CPFS[0]));
    await upload(office.token, '/api/imports/novos-clientes', 'b.csv', csv(VALID_CPFS[0]));
    await upload(office.token, '/api/imports/inss', 'inss.csv', `CPF;Senha gov.br\n${VALID_CPFS[0]};x`);

    const all = await office.api.get('/api/imports');
    expect(all.body.total).toBe(3);
    const hist = await office.api.get('/api/imports?kind=novos-clientes&pageSize=1');
    expect(hist.body).toMatchObject({ total: 2, pages: 2, page: 1 });
    expect(hist.body.data[0]).toMatchObject({ filename: 'b.csv', status: 'failed', failed: 1, createdByName: 'Ana Dona' });
    expect(hist.body.data[0].results).toBeUndefined();

    const report = await office.api.get(`/api/imports/${first.body.id}/report`);
    expect(report.status).toBe(200);
    const rows = sheetRows((await readXlsx(report.raw.rawPayload)).worksheets[0]);
    expect(rows[1]).toEqual(['2', 'Importada', `Cliente Cliente ${VALID_CPFS[0]} cadastrado.`]);

    expect((await office.api.get('/api/imports/orcamentos/template')).status).toBe(404);
    expect((await office.api.get('/api/imports?kind=desconhecido')).status).toBe(404);
  });

  it('exige a permissão de cada tipo', async () => {
    const office = await registerOffice(env);
    const batch = await upload(office.token, '/api/imports/novos-clientes', 'a.csv', `Nome;CPF;E-mail do responsável\nAna;${VALID_CPFS[0]};${office.email}`);
    await upload(office.token, '/api/imports/inss', 'inss.csv', `CPF;Senha gov.br\n${VALID_CPFS[0]};x`);

    const anon = await env.app.inject({ method: 'GET', url: '/api/imports/novos-clientes/template' });
    expect(anon.statusCode).toBe(401);

    const none = await createEmployee(env, office.api, ['customer.list']);
    expect((await none.api.get('/api/imports/novos-clientes/template')).status).toBe(403);
    expect((await none.api.post('/api/imports/novos-clientes', {})).status).toBe(403);
    expect((await none.api.get('/api/imports')).status).toBe(403);
    expect((await none.api.get(`/api/imports/${batch.body.id}`)).status).toBe(403);

    const partial = await createEmployee(env, office.api, ['worksheet.new_customers']);
    expect((await partial.api.get('/api/imports/novos-clientes/template')).status).toBe(200);
    expect((await partial.api.get('/api/imports/inss/template')).status).toBe(403);
    const list = await partial.api.get('/api/imports');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].kind).toBe('novos-clientes');
    expect((await partial.api.get('/api/imports?kind=inss')).status).toBe(403);
  });

  it('isola escritórios', async () => {
    const a = await registerOffice(env, 'Escritório A');
    const b = await registerOffice(env, 'Escritório B');
    const customer = await a.api.post('/api/customers', { name: 'Cliente do A', cpfCnpj: VALID_CPFS[0], email: 'a@ex.com' });
    const batch = await upload(a.token, '/api/imports/novos-clientes', 'a.csv', `Nome;CPF;E-mail do responsável\nAna;${VALID_CPFS[1]};${a.email}`);

    expect((await b.api.get(`/api/imports/${batch.body.id}`)).status).toBe(404);
    expect((await b.api.get(`/api/imports/${batch.body.id}/report`)).status).toBe(404);
    expect((await b.api.get('/api/imports')).body.total).toBe(0);

    // B não alcança clientes de A pelo CPF
    const upd = await upload(b.token, '/api/imports/atualizar-clientes', 'u.csv', `CPF;E-mail\n${VALID_CPFS[0]};invasor@ex.com`);
    expect(upd.body.results[0].message).toContain('não encontrado');
    expect((await a.api.get(`/api/customers/${customer.body.id}`)).body.email).toBe('a@ex.com');

    // responsável precisa ser colaborador do próprio escritório
    const cross = await upload(b.token, '/api/imports/novos-clientes', 'n.csv', `Nome;CPF;E-mail do responsável\nBeto;${VALID_CPFS[2]};${a.email}`);
    expect(cross.body.results[0].message).toContain('não é colaborador');
    // o mesmo CPF pode existir em escritórios diferentes
    const same = await upload(b.token, '/api/imports/novos-clientes', 'm.csv', `Nome;CPF;E-mail do responsável\nCliente;${VALID_CPFS[0]};${b.email}`);
    expect(same.body.succeeded).toBe(1);
  });
});
