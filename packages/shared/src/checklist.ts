/**
 * Regras do checklist digital do IRPF e textos do portal do cliente.
 *
 * - `buildChecklistDrafts` monta a lista de documentos a partir das linhas da declaração
 *   do ano anterior (dependentes, fontes pagadoras, pagamentos, bens, dívidas, atividade rural),
 *   completando com itens padrão nas seções sem histórico.
 * - `checklistLock` aplica as preferências do escritório que deixam o checklist só para consulta.
 * - `customerDeclarationStatus` traduz o status interno da declaração para o cliente final.
 */
import type { DeclarationItem } from './dirpf';
import { PAYMENT_NATURES, type PaymentNature } from './dirpf';
import {
  CHECKLIST_SECTIONS,
  DECLARATION_SUBSTATUS,
  STAGE_SUBSTATUS,
  stageOfSubstatus,
  type ChecklistItemStatus,
  type ChecklistSection,
  type ChecklistSectionStatus,
  type DeclarationStage,
  type DeclarationSubstatus,
} from './enums';
import { formatCpfCnpj, onlyDigits } from './validators';

// ---------------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------------

/** Seções que o cliente preenche e finaliza (o resumo é calculado). */
export const CHECKLIST_FILLABLE_SECTIONS: ChecklistSection[] = ['identification', 'family', 'income', 'payments', 'assets_debts', 'rural', 'files'];

/** Explicação curta de cada seção para o cliente. */
export const CHECKLIST_SECTION_HINTS: Record<ChecklistSection, string> = {
  identification: 'Seus dados pessoais e comprovantes básicos.',
  family: 'Dependentes e mudanças na família durante o ano.',
  income: 'Salário, aposentadoria, aluguéis, bancos e investimentos.',
  payments: 'Despesas com saúde, educação, previdência privada e doações.',
  assets_debts: 'Imóveis, veículos, contas, investimentos, empréstimos e financiamentos.',
  rural: 'Receitas, despesas e bens da atividade rural, se você tiver.',
  files: 'Qualquer outro documento que você queira mandar para o escritório.',
  summary: 'Veja como ficou cada seção.',
};

/** Rótulos do status do item na visão do cliente (mais diretos que os do escritório). */
export const CHECKLIST_ITEM_STATUS_CUSTOMER: Record<ChecklistItemStatus, string> = {
  pending: 'Pendente',
  sent: 'Enviado',
  not_applicable: 'Não se aplica',
  removed: 'Não tenho mais',
};

/** Opções de finalização de seção explicadas para o cliente. */
export const CHECKLIST_FINISH_OPTIONS: { value: Exclude<ChecklistSectionStatus, 'open'>; label: string; description: string }[] = [
  { value: 'done', label: 'Concluída', description: 'Enviei tudo o que tinha para esta seção.' },
  { value: 'pending_documents', label: 'Com documentos pendentes', description: 'Ainda falta algum documento. Vou mandar depois.' },
  { value: 'no_documents', label: 'Sem documentos', description: 'Não tenho nada para enviar nesta seção.' },
];

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** Tipos aceitos no checklist: PDF, imagens e planilhas (extensão → tipo MIME gravado). */
export const CHECKLIST_UPLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
};

export const CHECKLIST_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Valor para o atributo `accept` do campo de arquivo. */
export const CHECKLIST_UPLOAD_ACCEPT = Object.keys(CHECKLIST_UPLOAD_TYPES)
  .map((e) => `.${e}`)
  .join(',');

export function fileExtension(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : '';
}

/** Tipo MIME aceito para o nome do arquivo, ou `null` se a extensão não é permitida. */
export function checklistUploadMime(filename: string): string | null {
  return CHECKLIST_UPLOAD_TYPES[fileExtension(filename)] ?? null;
}

// ---------------------------------------------------------------------------
// Montagem do checklist a partir do ano anterior
// ---------------------------------------------------------------------------
export interface ChecklistItemDraft {
  section: ChecklistSection;
  title: string;
  description: string | null;
  ownerName: string | null;
  ownerCpf: string | null;
  fromPreviousYear: boolean;
}

const MAX_TITLE = 160;
const clip = (s: string, n = MAX_TITLE) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const INCOME_KINDS = new Set(['income_pj', 'income_pf', 'income_exempt', 'income_exclusive', 'income_suspended', 'income_accumulated']);
/** Grupos de bens que são contas e aplicações: agrupados por instituição. */
const FINANCIAL_ASSET_GROUPS = new Set(['04', '06', '07']);

const ASSET_HINTS: Record<string, string> = {
  '01': 'Se houve compra, venda, reforma ou financiamento, envie os comprovantes. Se nada mudou, marque “Não se aplica”.',
  '02': 'Se houve compra, venda ou financiamento, envie os comprovantes. Se nada mudou, marque “Não se aplica”.',
  '03': 'Envie alterações no contrato social e o informe de rendimentos da empresa, se houver.',
  '05': 'Envie o contrato ou comprovante do valor que tem a receber em 31/12.',
  '08': 'Envie o extrato da corretora ou exchange com o saldo em 31/12.',
};
const FINANCIAL_HINT = 'Envie o informe de rendimentos da instituição, com o saldo em 31/12.';
const ASSET_GENERIC_HINT = 'Se houve alguma mudança no ano, envie os comprovantes. Se nada mudou, marque “Não se aplica”.';

const DEFAULTS: Record<Exclude<ChecklistSection, 'summary'>, { title: string; description: string }[]> = {
  identification: [
    { title: 'Comprovante de endereço', description: 'Conta de luz, água, internet ou similar, dos últimos três meses.' },
    { title: 'Dados bancários para restituição', description: 'Banco, agência e conta em seu nome. Pode escrever na observação e marcar como enviado.' },
    { title: 'Mudanças no seu cadastro', description: 'Mudou de endereço, profissão, estado civil ou telefone? Conte na observação.' },
  ],
  family: [
    { title: 'Dados dos dependentes', description: 'Nome, CPF e data de nascimento de cada pessoa que depende de você (filhos, cônjuge, pais).' },
    { title: 'Mudanças na família', description: 'Casamento, separação, nascimento ou falecimento no ano? Envie a certidão.' },
  ],
  income: [
    { title: 'Informe de rendimentos do trabalho', description: 'Comprovante anual da empresa onde trabalha (salário, pró-labore, férias, 13º).' },
    { title: 'Informes de bancos e corretoras', description: 'Informe de rendimentos de cada banco, corretora ou cooperativa em que você tem conta ou investimento.' },
    { title: 'Aposentadoria ou pensão', description: 'Informe de rendimentos do INSS ou do órgão que paga sua aposentadoria/pensão.' },
    { title: 'Aluguéis e outros rendimentos', description: 'Recibos de aluguel, serviços prestados a pessoas físicas, pensão recebida ou rendimentos do exterior.' },
  ],
  payments: [
    { title: 'Despesas médicas e plano de saúde', description: 'Recibos e notas de médicos, dentistas, psicólogos, exames, hospitais e o informe do plano de saúde.' },
    { title: 'Despesas com educação', description: 'Comprovantes de escola, faculdade, pós-graduação ou curso técnico (seus e dos dependentes).' },
    { title: 'Previdência privada', description: 'Informe anual do plano de previdência (PGBL, VGBL ou fundo de pensão).' },
    { title: 'Pensão alimentícia paga', description: 'Decisão judicial ou escritura e os comprovantes dos valores pagos.' },
    { title: 'Doações', description: 'Recibos de doações a fundos da criança, do idoso, projetos culturais ou esportivos.' },
  ],
  assets_debts: [
    { title: 'Imóveis e veículos', description: 'Contratos e comprovantes de compra, venda, reforma ou financiamento feitos no ano.' },
    { title: 'Contas e investimentos', description: 'Saldo em 31/12 de contas, poupança, investimentos e criptoativos (o informe do banco serve).' },
    { title: 'Empréstimos e financiamentos', description: 'Extrato com o saldo devedor em 31/12 de empréstimos e financiamentos.' },
  ],
  rural: [
    { title: 'Atividade rural', description: 'Se tem atividade rural, envie o livro-caixa e as notas de produtor. Se não tem, marque “Não se aplica”.' },
  ],
  files: [{ title: 'Outros documentos', description: 'Algum documento que não se encaixou nas seções anteriores? Envie aqui.' }],
};

/**
 * Monta os itens do checklist do ano a partir das linhas da declaração do ano anterior.
 * Itens do mesmo titular e da mesma fonte pagadora/instituição viram um item só.
 * Seções sem histórico recebem os itens padrão.
 */
export function buildChecklistDrafts(previous: DeclarationItem[], opts: { customerCpf?: string | null; hasPreviousDeclaration?: boolean } = {}): ChecklistItemDraft[] {
  const customerCpf = onlyDigits(opts.customerCpf);
  const out: ChecklistItemDraft[] = [];
  const seen = new Set<string>();

  /** Titular da linha: nulo quando é o próprio cliente. */
  const owner = (i: DeclarationItem): { ownerName: string | null; ownerCpf: string | null } => {
    const cpf = onlyDigits(i.ownerCpf);
    if (!cpf || cpf === customerCpf) return { ownerName: null, ownerCpf: null };
    return { ownerName: clean(i.ownerName) || formatCpfCnpj(cpf), ownerCpf: cpf };
  };
  const payer = (i: DeclarationItem) => clean(i.counterpartyName) || (i.counterpartyDoc ? formatCpfCnpj(onlyDigits(i.counterpartyDoc)) : '');
  const payerKey = (i: DeclarationItem) => onlyDigits(i.counterpartyDoc) || clean(i.counterpartyName).toLowerCase();

  const push = (key: string, draft: Omit<ChecklistItemDraft, 'fromPreviousYear' | 'ownerName' | 'ownerCpf'>, item?: DeclarationItem) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...draft, title: clip(draft.title), ...(item ? owner(item) : { ownerName: null, ownerCpf: null }), fromPreviousYear: Boolean(item) });
  };

  for (const i of previous) {
    const o = owner(i);
    const who = o.ownerCpf ?? 'titular';
    if (i.kind === 'dependent') {
      const name = clean(i.ownerName) || clean(i.description) || formatCpfCnpj(onlyDigits(i.ownerCpf));
      const cpf = onlyDigits(i.ownerCpf) || null;
      const key = `dep|${cpf ?? name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        section: 'family',
        title: clip(`Dependente: ${name || 'sem nome informado'}`),
        description: 'Continua como seu dependente este ano? Se não, marque “Não tenho mais”. Se algo mudou (escola, plano de saúde, renda), conte na observação.',
        ownerName: name || null,
        ownerCpf: cpf,
        fromPreviousYear: true,
      });
    } else if (INCOME_KINDS.has(i.kind)) {
      const name = payer(i);
      if (name) {
        push(`inc|${who}|${payerKey(i)}`, { section: 'income', title: `Informe de rendimentos — ${name}`, description: 'Comprovante anual enviado pela fonte pagadora (empresa, banco, INSS, corretora).' }, i);
      } else if (i.kind === 'income_pf') {
        push(`inc|${who}|pf`, { section: 'income', title: 'Rendimentos recebidos de pessoas físicas ou do exterior', description: 'Aluguéis, serviços prestados a pessoas físicas ou pensão recebida: envie os recibos ou o Carnê-Leão.' }, i);
      } else {
        const desc = clean(i.description) || 'Rendimento declarado no ano anterior';
        push(`inc|${who}|${desc.toLowerCase()}`, { section: 'income', title: `Rendimento: ${desc}`, description: 'Envie o comprovante deste rendimento no ano.' }, i);
      }
    } else if (i.kind === 'variable_income') {
      const name = payer(i);
      push(`var|${who}|${payerKey(i)}`, { section: 'income', title: name ? `Operações em bolsa — ${name}` : 'Operações em bolsa de valores', description: 'Notas de corretagem e o informe de rendimentos da corretora.' }, i);
    } else if (i.kind === 'payment' || i.kind === 'donation') {
      const name = payer(i) || clean(i.description) || (i.kind === 'donation' ? 'doação' : 'pagamento');
      const nature = (i.extra?.nature as PaymentNature | undefined) ?? undefined;
      const natureLabel = nature && PAYMENT_NATURES[nature] ? PAYMENT_NATURES[nature] : null;
      push(
        `pay|${i.kind}|${who}|${payerKey(i) || name.toLowerCase()}`,
        {
          section: 'payments',
          title: i.kind === 'donation' ? `Recibo de doação — ${name}` : `Comprovantes de pagamento — ${name}`,
          description: natureLabel ? `${natureLabel}: envie os recibos ou notas do ano.` : 'Envie os recibos ou notas fiscais do ano.',
        },
        i,
      );
    } else if (i.kind === 'tax_paid') {
      push(`tax|${who}`, { section: 'payments', title: 'Impostos pagos (DARF)', description: 'Comprovantes de DARF pagos no ano (Carnê-Leão, ganho de capital, quotas do IR).' }, i);
    } else if (i.kind === 'asset') {
      const group = clean(i.groupCode).padStart(2, '0');
      const desc = clean(i.description) || 'Bem declarado no ano anterior';
      const name = payer(i);
      if (FINANCIAL_ASSET_GROUPS.has(group) && name) {
        push(`fin|${who}|${payerKey(i)}`, { section: 'assets_debts', title: `Saldos em 31/12 — ${name}`, description: FINANCIAL_HINT }, i);
      } else {
        push(`ast|${who}|${desc.toLowerCase()}`, { section: 'assets_debts', title: `Bem: ${desc}`, description: FINANCIAL_ASSET_GROUPS.has(group) ? FINANCIAL_HINT : (ASSET_HINTS[group] ?? ASSET_GENERIC_HINT) }, i);
      }
    } else if (i.kind === 'debt') {
      const desc = clean(i.description) || payer(i) || 'Dívida declarada no ano anterior';
      push(`debt|${who}|${desc.toLowerCase()}`, { section: 'assets_debts', title: `Dívida: ${desc}`, description: 'Envie o extrato com o saldo devedor em 31/12. Se quitou no ano, envie o comprovante e marque “Não tenho mais”.' }, i);
    } else if (i.kind === 'rural_income' || i.kind === 'rural_expense') {
      push(`rural|book|${who}`, { section: 'rural', title: 'Livro-caixa da atividade rural', description: 'Receitas e despesas do ano, com as notas de produtor.' }, i);
    } else if (i.kind === 'rural_asset' || i.kind === 'rural_debt') {
      const desc = clean(i.description) || 'Item da atividade rural';
      const label = i.kind === 'rural_asset' ? 'Bem rural' : 'Dívida rural';
      push(`rural|${i.kind}|${who}|${desc.toLowerCase()}`, { section: 'rural', title: `${label}: ${desc}`, description: 'Envie os comprovantes de mudanças no ano. Se nada mudou, marque “Não se aplica”.' }, i);
    }
    // capital_gain: venda pontual do ano anterior, não se repete; fica fora do checklist.
  }

  const withHistory = new Set(out.map((d) => d.section));
  const defaults: ChecklistItemDraft[] = [];
  for (const section of CHECKLIST_FILLABLE_SECTIONS) {
    if (withHistory.has(section)) continue;
    const list = [...DEFAULTS[section as Exclude<ChecklistSection, 'summary'>]];
    if (section === 'identification' && !opts.hasPreviousDeclaration) {
      list.unshift(
        { title: 'Documento de identificação com CPF', description: 'RG, CNH ou outro documento oficial com foto e CPF.' },
        { title: 'Última declaração entregue', description: 'Se você declarou no ano passado, envie a declaração e o recibo de entrega.' },
      );
    }
    for (const d of list) defaults.push({ section, title: d.title, description: d.description, ownerName: null, ownerCpf: null, fromPreviousYear: false });
  }

  const order = (s: ChecklistSection) => CHECKLIST_FILLABLE_SECTIONS.indexOf(s);
  return [...out, ...defaults].sort((a, b) => order(a.section) - order(b.section));
}

// ---------------------------------------------------------------------------
// Bloqueio do checklist conforme as preferências do escritório
// ---------------------------------------------------------------------------
const STAGE_ORDER: DeclarationStage[] = ['not_started', 'negotiation', 'filling', 'transmitted', 'finished'];

/** Posição do subestado no fluxo (para comparar "a partir de"). */
export function substatusRank(s: DeclarationSubstatus): number {
  const stage = stageOfSubstatus(s);
  return STAGE_ORDER.indexOf(stage) * 100 + STAGE_SUBSTATUS[stage].indexOf(s);
}

export interface ChecklistLock {
  readOnly: boolean;
  /** Motivo para o escritório. */
  reason: string | null;
  /** Motivo em linguagem simples para o cliente. */
  customerReason: string | null;
}

export function checklistLock(
  settings: { checklistReadOnlyAfterStart?: boolean | null; lockChecklistFromSubstatus?: string | null },
  declaration: { substatus: string; checklistLocked?: boolean | null },
): ChecklistLock {
  const sub = (declaration.substatus in DECLARATION_SUBSTATUS ? declaration.substatus : 'not_started') as DeclarationSubstatus;
  if (declaration.checklistLocked) {
    return {
      readOnly: true,
      reason: 'Bloqueado pelo escritório.',
      customerReason: 'O escritório encerrou o envio de documentos por aqui. Se precisar mandar algo, fale com o escritório.',
    };
  }
  const stage = stageOfSubstatus(sub);
  if (settings.checklistReadOnlyAfterStart && STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf('filling')) {
    return {
      readOnly: true,
      reason: 'Em modo consulta: a declaração já passou da etapa “Em preenchimento” (preferência do escritório).',
      customerReason: 'Sua declaração já foi entregue. O checklist fica disponível só para consulta.',
    };
  }
  const from = settings.lockChecklistFromSubstatus;
  if (from && from in DECLARATION_SUBSTATUS && substatusRank(sub) >= substatusRank(from as DeclarationSubstatus)) {
    return {
      readOnly: true,
      reason: `Bloqueado para o cliente a partir do status “${DECLARATION_SUBSTATUS[from as DeclarationSubstatus]}” (preferência do escritório).`,
      customerReason: 'Sua declaração já está numa fase avançada. O checklist fica disponível só para consulta.',
    };
  }
  return { readOnly: false, reason: null, customerReason: null };
}

// ---------------------------------------------------------------------------
// Status da declaração em linguagem simples (portal do cliente)
// ---------------------------------------------------------------------------
export type CustomerTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const CUSTOMER_STATUS: Record<DeclarationSubstatus, { title: string; description: string; tone: CustomerTone }> = {
  not_started: { title: 'Ainda não iniciada', description: 'Sua declaração ainda não começou a ser preparada.', tone: 'neutral' },
  budget_sent: { title: 'Aguardando sua aprovação', description: 'Enviamos um orçamento. Confira e aprove para começarmos.', tone: 'warning' },
  budget_approved: { title: 'Orçamento aprovado', description: 'Tudo certo com o orçamento. Em breve começaremos sua declaração.', tone: 'primary' },
  started: { title: 'Em andamento', description: 'Começamos a preparar sua declaração.', tone: 'primary' },
  elaboration: { title: 'Em preparação', description: 'Estamos preenchendo sua declaração com os documentos recebidos.', tone: 'primary' },
  missing_documents: { title: 'Faltam documentos', description: 'Precisamos de alguns documentos seus para continuar.', tone: 'warning' },
  review: { title: 'Em revisão', description: 'Sua declaração está pronta e passa pela revisão final.', tone: 'primary' },
  ecac_unknown: { title: 'Entregue à Receita', description: 'Sua declaração foi entregue à Receita Federal.', tone: 'success' },
  ecac_waiting: { title: 'Entregue à Receita', description: 'Sua declaração foi entregue e aguarda o processamento da Receita Federal.', tone: 'success' },
  ecac_processing: { title: 'Em processamento na Receita', description: 'A Receita Federal está processando sua declaração.', tone: 'primary' },
  ecac_fine_mesh: { title: 'Em análise pela Receita', description: 'A Receita pediu uma verificação (malha fina). Fique tranquilo: o escritório vai orientar você.', tone: 'danger' },
  ecac_refund: { title: 'Restituição liberada', description: 'A Receita Federal liberou sua restituição.', tone: 'success' },
  ecac_processed: { title: 'Processada', description: 'A Receita Federal concluiu o processamento da sua declaração.', tone: 'success' },
  finished: { title: 'Concluída', description: 'Sua declaração foi concluída.', tone: 'success' },
};

export function customerDeclarationStatus(substatus: string | null | undefined): { title: string; description: string; tone: CustomerTone } {
  return CUSTOMER_STATUS[(substatus ?? 'not_started') as DeclarationSubstatus] ?? CUSTOMER_STATUS.not_started;
}

/** Contagem dos itens por status, ignorando os removidos neste ano no total a resolver. */
export function checklistProgress(items: { status: string }[]) {
  const by = (s: ChecklistItemStatus) => items.filter((i) => i.status === s).length;
  const pending = by('pending');
  const total = items.length;
  const resolved = total - pending;
  return { total, pending, sent: by('sent'), notApplicable: by('not_applicable'), removed: by('removed'), resolved, percent: total ? Math.round((resolved / total) * 100) : 0 };
}

export const checklistSectionLabel = (s: string) => CHECKLIST_SECTIONS[s as ChecklistSection] ?? s;
