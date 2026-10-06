/**
 * Livro caixa / Carnê-Leão Web.
 *
 * O escritório baixa um modelo (CSV com cabeçalho), o cliente preenche, o Verifco converte e
 * valida cada linha e grava os lançamentos; depois exporta no formato de importação de
 * escrituração do Carnê-Leão Web.
 *
 * Layout de exportação conforme os modelos oficiais publicados pela Receita Federal
 * ("Modelos de escrituração para o Carnê-Leão", atualizados em 20/10/2025):
 * https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/escrituracao-do-carne-leao/escrituracao-carne-leao.zip/view
 * - CSV separado por ponto e vírgula, sem cabeçalho, até 1.000 linhas por arquivo;
 * - rendimentos: data; código do rendimento; código de ocupação; valor; dedução; histórico;
 *   recebido de (PF/PJ/EX); CPF do titular; CPF do beneficiário; indicador de CPF não
 *   informado; CNPJ; indicador de IRRF (S/N); valor do IRRF;
 * - pagamentos: data; código do pagamento; valor; histórico; multa; juros; competência (MM/AAAA)
 *   — os três últimos só para "Imposto pago" e "Previdência oficial".
 *
 * Os códigos de rendimento, pagamento e ocupação são conferidos nas tabelas auxiliares do manual do
 * Carnê-Leão (ver `CARNE_LEAO_TABLES`), com a validade de cada código por ano-calendário.
 */
import { isValidCnpj, isValidCpf, onlyDigits, toCents } from './validators';

export const CARNE_LEAO_MODELS_URL =
  'https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/escrituracao-do-carne-leao/escrituracao-carne-leao.zip/view';
/** Manual do Carnê-Leão da Receita Federal (o endereço antigo, "topicos-ajuda-carne-leao-web", saiu do ar). */
export const CARNE_LEAO_MANUAL_URL = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual/manual';
/** "Tabelas auxiliares" ficam no fim do manual. */
export const CARNE_LEAO_TABLES_URL = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/manual';
/** Seção "Escrituração" do manual: importação dos arquivos. */
export const CARNE_LEAO_IMPORT_URL = `${CARNE_LEAO_MANUAL_URL}#escrituracao`;

/** Limite de linhas por envio (igual ao limite de importação do Carnê-Leão Web). */
export const CASHBOOK_MAX_ROWS = 1000;

/** Tamanho máximo do histórico no arquivo de escrituração ("Formato do arquivo" do manual). */
export const CARNE_LEAO_HISTORY_MAX = 255;

export type CashbookKind = 'income' | 'payment';

export const INCOME_HEADERS = [
  'Data',
  'Código do rendimento',
  'Código de ocupação',
  'Valor recebido',
  'Valor de dedução',
  'Histórico',
  'Recebido de',
  'CPF do titular do pagamento',
  'CPF do beneficiário',
  'CPF do beneficiário não informado',
  'CNPJ',
  'Houve IRRF',
  'Valor do IRRF',
];

export const PAYMENT_HEADERS = ['Data', 'Código do pagamento', 'Valor pago', 'Histórico', 'Valor da multa', 'Valor dos juros', 'Competência'];

export interface CashbookModel {
  key: string;
  kind: CashbookKind;
  label: string;
  description: string;
  /** Linhas de exemplo (iguais às dos modelos oficiais, com 99/99/9999 no lugar da data). */
  rows: string[][];
}

const ex = (...cells: string[]) => cells;
const D = '99/99/9999';

export const CASHBOOK_MODELS: CashbookModel[] = [
  { key: 'rendimentos-vazio', kind: 'income', label: 'Modelo vazio', description: 'Somente o cabeçalho dos rendimentos.', rows: [] },
  {
    key: 'rendimentos-aluguel-outros',
    kind: 'income',
    label: 'Aluguel e outros rendimentos',
    description: 'Aluguéis recebidos de pessoa física ou do exterior (com ou sem dedução) e outros rendimentos.',
    rows: [
      ex(D, 'R01.003.001', '', '0,00', '', 'Aluguel recebido de pessoa física', 'PF'),
      ex(D, 'R01.003.001', '', '0,00', '0,00', 'Aluguel recebido de pessoa física com dedução (IPTU, condomínio, administração)', 'PF'),
      ex(D, 'R01.003.001', '', '0,00', '', 'Aluguel recebido do exterior', 'EX'),
      ex(D, 'R01.004.001', '', '0,00', '', 'Outros rendimentos recebidos de pessoa física', 'PF'),
      ex(D, 'R01.004.001', '', '0,00', '', 'Outros rendimentos recebidos do exterior', 'EX'),
    ],
  },
  {
    key: 'rendimentos-notariais',
    kind: 'income',
    label: 'Serviços notariais e de registro',
    description: 'Rendimentos de titulares de cartórios (ocupação 117).',
    rows: [
      ex(D, 'R01.001.002', '117', '0,00', '', 'Serviços notariais recebidos de pessoa física', 'PF', '00000000000'),
      ex(D, 'R01.001.002', '117', '0,00', '', 'Serviços notariais recebidos de pessoa jurídica com IRRF', 'PJ', '', '', '', '00000000000000', 'S', '0,00'),
      ex(D, 'R01.001.002', '117', '0,00', '', 'Serviços notariais recebidos de pessoa jurídica sem IRRF', 'PJ', '', '', '', '00000000000000', 'N'),
      ex(D, 'R01.001.002', '117', '0,00', '', 'Serviços notariais recebidos do exterior', 'EX'),
    ],
  },
  {
    key: 'rendimentos-trabalho-nao-assalariado',
    kind: 'income',
    label: 'Trabalho não assalariado',
    description: 'Profissionais autônomos: informe o código de ocupação da tabela da Receita.',
    rows: [
      ex(D, 'R01.001.001', '', '0,00', '', 'Serviço prestado a pessoa física (CPF do beneficiário informado)', 'PF', '00000000000', '00000000000'),
      ex(D, 'R01.001.001', '', '0,00', '', 'Serviço prestado a pessoa física (beneficiário sem CPF)', 'PF', '00000000000', '', 'S'),
      ex(D, 'R01.001.001', '', '0,00', '', 'Serviço prestado a pessoa jurídica com IRRF', 'PJ', '', '', '', '00000000000000', 'S', '0,00'),
      ex(D, 'R01.001.001', '', '0,00', '', 'Serviço prestado a pessoa jurídica sem IRRF', 'PJ', '', '', '', '00000000000000', 'N'),
      ex(D, 'R01.001.001', '', '0,00', '', 'Serviço prestado no exterior', 'EX'),
    ],
  },
  { key: 'pagamentos-vazio', kind: 'payment', label: 'Modelo vazio', description: 'Somente o cabeçalho dos pagamentos.', rows: [] },
  {
    key: 'pagamentos-plano-de-contas',
    kind: 'payment',
    label: 'Pagamentos do plano de contas padrão',
    description: 'Despesas dedutíveis (P10) e não dedutíveis (P11) do livro caixa.',
    rows: [
      ['P10.01.00001', 'Água do escritório/consultório'],
      ['P10.01.00002', 'Aluguel do escritório/consultório'],
      ['P10.01.00003', 'Condomínio do escritório/consultório'],
      ['P10.01.00004', 'Contribuições obrigatórias a entidades de classe'],
      ['P10.01.00005', 'Cópia e autenticação de documentos'],
      ['P10.01.00006', 'Emolumentos pagos a terceiros'],
      ['P10.01.00007', 'Energia do escritório/consultório'],
      ['P10.01.00008', 'Gás do escritório/consultório'],
      ['P10.01.00009', 'IPTU do escritório/consultório quando pago pelo contribuinte'],
      ['P10.01.00010', 'ISS'],
      ['P10.01.00011', 'Material de conservação e limpeza do escritório/consultório'],
      ['P10.01.00012', 'Material de escritório'],
      ['P10.01.00013', 'Remuneração paga a terceiros, com vínculo empregatício, INSS e FGTS'],
      ['P10.01.00014', 'Telefone do escritório/consultório'],
      ['P11.01.00001', 'Aplicação de capital'],
      ['P11.01.00002', 'Aquisição de computador'],
      ['P11.01.00003', 'Aquisição de linha telefônica/aparelho telefônico'],
      ['P11.01.00004', 'Aquisição de máquina e equipamento'],
      ['P11.01.00005', 'Arrendamento mercantil (leasing) de automóveis, equipamentos e máquinas'],
      ['P11.01.00006', 'Carnê-leão pago'],
      ['P11.01.00007', 'Combustível'],
      ['P11.01.00008', 'Conservação e reforma do imóvel do contribuinte'],
      ['P11.01.00009', 'Depreciação de instalações e equipamentos'],
      ['P11.01.00010', 'Despesas de locomoção e transporte, salvo de representante comercial autônomo'],
      ['P11.01.00011', 'Enciclopédia ou livros/revistas em geral'],
      ['P11.01.00012', 'Estacionamento'],
      ['P11.01.00013', 'IPTU de imóvel residencial'],
      ['P11.01.00014', 'Manutenção do veículo'],
      ['P11.01.00015', 'Imposto complementar pago'],
      ['P11.01.00016', 'Seguro de vida'],
      ['P11.01.00017', 'Seguro de imóvel residencial'],
      ['P11.01.00018', 'Seguro de carro'],
    ].map(([code, label]) => ex(D, code, '0,00', label)),
  },
  {
    key: 'pagamentos-gerais',
    kind: 'payment',
    label: 'Pagamentos gerais',
    description: 'Previdência oficial, pensão alimentícia, imposto pago (só até 2025) e imposto pago no exterior.',
    rows: [
      ex(D, 'P20.01.00001', '0,00', 'Previdência oficial', '0,00', '', '99/9999'),
      ex(D, 'P20.01.00002', '0,00', 'Pensão alimentícia', '', '', ''),
      ex(D, 'P20.01.00003', '0,00', 'Imposto pago no exterior', '', '', ''),
      ex(D, 'P20.01.00004', '0,00', 'Imposto pago', '0,00', '0,00', '99/9999'),
    ],
  },
];

/** Guia de preenchimento exibido na tela (campos e formatos). */
export const CASHBOOK_GUIDE: { kind: CashbookKind; field: string; format: string; required: string }[] = [
  { kind: 'income', field: 'Data', format: 'DD/MM/AAAA, dentro do ano-calendário escolhido', required: 'Sim' },
  { kind: 'income', field: 'Código do rendimento', format: 'Código da tabela de rendimentos (ex.: R01.003.001); veja "Tabelas de códigos"', required: 'Sim' },
  { kind: 'income', field: 'Código de ocupação', format: 'Código da tabela de ocupações (ex.: 225); 117 para serviços notariais', required: 'Para códigos R01.001.*' },
  { kind: 'income', field: 'Valor recebido', format: 'Valor em reais: 1234,56 ou 1.234,56', required: 'Sim' },
  { kind: 'income', field: 'Valor de dedução', format: 'Valor em reais (despesas do aluguel, quando aplicável)', required: 'Não' },
  { kind: 'income', field: 'Histórico', format: 'Texto livre de até 255 caracteres, sem ponto e vírgula', required: 'Sim' },
  { kind: 'income', field: 'Recebido de', format: 'PF (pessoa física), PJ (pessoa jurídica) ou EX (exterior)', required: 'Sim' },
  { kind: 'income', field: 'CPF do titular do pagamento', format: '11 dígitos, com ou sem pontuação', required: 'Quando recebido de PF' },
  { kind: 'income', field: 'CPF do beneficiário', format: '11 dígitos', required: 'Trabalho não assalariado de PF, salvo se marcado "não informado"' },
  { kind: 'income', field: 'CPF do beneficiário não informado', format: 'S ou vazio', required: 'Não' },
  { kind: 'income', field: 'CNPJ', format: '14 dígitos, com ou sem pontuação', required: 'Quando recebido de PJ' },
  { kind: 'income', field: 'Houve IRRF', format: 'S ou N', required: 'Quando recebido de PJ' },
  { kind: 'income', field: 'Valor do IRRF', format: 'Valor em reais', required: 'Quando "Houve IRRF" = S' },
  { kind: 'payment', field: 'Data', format: 'DD/MM/AAAA, dentro do ano-calendário escolhido', required: 'Sim' },
  {
    kind: 'payment',
    field: 'Código do pagamento',
    format: 'Código dos pagamentos gerais (P20) ou do plano de contas (P10 dedutível, P11 não dedutível; ex.: P10.01.00001)',
    required: 'Sim',
  },
  { kind: 'payment', field: 'Valor pago', format: 'Valor em reais', required: 'Sim' },
  { kind: 'payment', field: 'Histórico', format: 'Texto livre de até 255 caracteres, sem ponto e vírgula', required: 'Sim' },
  { kind: 'payment', field: 'Valor da multa', format: 'Valor em reais', required: 'Só para imposto pago e previdência oficial' },
  { kind: 'payment', field: 'Valor dos juros', format: 'Valor em reais', required: 'Só para imposto pago e previdência oficial' },
  { kind: 'payment', field: 'Competência', format: 'MM/AAAA', required: 'Só para imposto pago e previdência oficial' },
];

const csvCell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Conteúdo CSV (com cabeçalho, separado por ponto e vírgula) do modelo para download. Com o
 * ano-calendário, ficam de fora as linhas de códigos que não valem no ano (ex.: imposto pago a partir de 2026).
 */
export function cashbookModelCsv(key: string, calendarYear?: number): { filename: string; content: string } | null {
  const model = CASHBOOK_MODELS.find((m) => m.key === key);
  if (!model) return null;
  const headers = model.kind === 'income' ? INCOME_HEADERS : PAYMENT_HEADERS;
  const rows = calendarYear === undefined ? model.rows : model.rows.filter((r) => carneLeaoCodeProblem(model.kind, r[1], calendarYear) === null);
  const lines = [headers, ...rows.map((r) => [...r, ...Array(Math.max(0, headers.length - r.length)).fill('')])].map((r) => r.map(csvCell).join(';'));
  return { filename: `livro-caixa-${model.key}.csv`, content: lines.join('\r\n') + '\r\n' };
}

// ---------------------------------------------------------------------------
// Tabelas de códigos do Carnê-Leão Web
// ---------------------------------------------------------------------------
/**
 * Código de uma tabela auxiliar do Carnê-Leão Web. `from`/`until` limitam os anos-calendário em que
 * o código vale (sem eles, vale em todos); `note` explica o que usar fora desse período.
 */
export interface CarneLeaoCode {
  code: string;
  label: string;
  from?: number;
  until?: number;
  note?: string;
}

const c = (code: string, label: string, validity: Pick<CarneLeaoCode, 'from' | 'until' | 'note'> = {}): CarneLeaoCode => ({ code, label, ...validity });

/**
 * Tabelas auxiliares do manual do Carnê-Leão (Receita Federal), conferidas em 06/10/2026
 * (fontes e método registrados em docs/revisao/carne-leao-fontes.md):
 * - rendimentos: .../carne-leao/manual/rendimentos;
 * - pagamentos gerais: .../carne-leao/manual/pagamentos (atualizada em 02/07/2026, já sem o
 *   P20.01.00004) e o modelo "Pagamentos" do arquivo de modelos de escrituração. Pelo manual, a
 *   partir do ano-calendário de 2026 o "Imposto pago" não pode mais ser incluído: entra sozinho no
 *   Carnê-Leão Web depois que o pagamento é confirmado;
 * - plano de contas padrão: .../carne-leao/manual/pagamentos-plano. Contas de um plano de contas
 *   próprio do contribuinte também valem ("P10 + . + código da conta" para despesa dedutível,
 *   "P11 + . + código da conta" para não dedutível), por isso P10/P11 fora desta tabela são aceitos;
 * - ocupações: .../carne-leao/manual/ocupacoes (atualizada em 30/01/2024; o 229 vale até 2023 e
 *   o 230, o 231 e o 232 a partir de 2024, pela Instrução Normativa RFB nº 2.177/2024).
 */
export const CARNE_LEAO_TABLES: Record<'income' | 'generalPayment' | 'chart' | 'occupation', { label: string; codes: CarneLeaoCode[] }> = {
  income: {
    label: 'Rendimentos',
    codes: [
      c('R01.001.001', 'Trabalho não assalariado'),
      c('R01.001.002', 'Serviços notariais e de registro'),
      c('R01.002.001', 'Pensão alimentícia'),
      c('R01.003.001', 'Aluguel'),
      c('R01.004.001', 'Outros'),
    ],
  },
  generalPayment: {
    label: 'Pagamentos gerais',
    codes: [
      c('P20.01.00001', 'Previdência oficial'),
      c('P20.01.00002', 'Pensão alimentícia'),
      c('P20.01.00003', 'Imposto pago no exterior'),
      c('P20.01.00004', 'Imposto pago', {
        until: 2025,
        note: 'A partir de 2026, o imposto pago entra sozinho no Carnê-Leão Web depois que o pagamento é confirmado e não pode mais ser incluído.',
      }),
    ],
  },
  chart: {
    label: 'Plano de contas padrão',
    codes: (CASHBOOK_MODELS.find((m) => m.key === 'pagamentos-plano-de-contas')?.rows ?? []).map((r) => c(r[1], r[3])),
  },
  occupation: {
    label: 'Ocupações',
    codes: [
      c('101', 'Membro do Poder Executivo (Presidente da República, Vice-Presidente da República, Ministro de Estado, Governador, Vice-Governador, Prefeito, Vice-Prefeito)'),
      c('102', 'Membro do Poder Judiciário (Ministro, Juiz e Desembargador) e de Tribunal de Contas (Ministro e Conselheiro)'),
      c('103', 'Membro do Poder Legislativo (Senador, Deputado Federal, Deputado Estadual e Vereador)'),
      c('104', 'Membro do Ministério Público (Procurador e Promotor)'),
      c('105', 'Dirigente superior da administração pública (ocupante de cargo de direção, chefia, assessoria e de natureza especial), inclusive os das fundações públicas e autarquias'),
      c('106', 'Diplomata e afins'),
      c('107', 'Servidor das carreiras do Poder Legislativo'),
      c('108', 'Servidor das carreiras do Ministério Público'),
      c('109', 'Servidor das carreiras do Poder Judiciário, Oficial de Justiça, Auxiliar, Assistente e Analista Judiciário'),
      c('110', 'Advogado do setor público, Procurador da Fazenda, Consultor Jurídico, Procurador de autarquias e fundações públicas, Defensor Público'),
      c('111', 'Servidor das carreiras de auditoria fiscal e de fiscalização'),
      c('112', 'Servidor das carreiras do Banco Central, CVM e Susep'),
      c('113', 'Delegado de Polícia e outros servidores das carreiras de polícia, exceto militar'),
      c('114', 'Servidor das carreiras de gestão governamental, analista, gestor e técnico de planejamento'),
      c('115', 'Servidor das carreiras de ciência e tecnologia'),
      c('116', 'Servidor das demais carreiras da administração pública direta, autárquica e fundacional'),
      c('117', 'Titular de Cartório'),
      c('118', 'Dirigente ou administrador de partido político, organização patronal, sindical, filantrópica e religiosa'),
      c('120', 'Dirigente, presidente e diretor de empresa industrial, comercial ou prestadora de serviços'),
      c('121', 'Presidente e diretor de empresa pública e sociedade de economia mista'),
      c('130', 'Gerente ou supervisor de empresa industrial, comercial ou prestadora de serviços'),
      c('131', 'Gerente ou supervisor de empresa pública e sociedade de economia mista'),
      c('140', 'Presidente, diretor, gerente e supervisor de organismo internacional e de organização não-governamental'),
      c('211', 'Matemático, estatístico, atuário e afins'),
      c('212', 'Analista de sistemas, desenvolvedor de software, administrador de redes e bancos de dados e outros especialistas em informática (exceto técnico)'),
      c('213', 'Físico, químico, meteorologista, geólogo, oceanógrafo e afins'),
      c('214', 'Engenheiro, arquiteto e afins'),
      c('215', 'Piloto de aeronaves, comandante de embarcações e oficiais de máquinas'),
      c('221', 'Biólogo, biomédico e afins'),
      c('222', 'Agrônomo e afins'),
      c('224', 'Profissional da educação física (exceto professor)'),
      c('225', 'Médico'),
      c('226', 'Odontólogo'),
      c('227', 'Enfermeiro de nível superior, nutricionista, farmacêutico e afins'),
      c('228', 'Veterinário, patologista (veterinário) e zootecnista'),
      c('229', 'Fonoaudiólogo, fisioterapeuta, terapeuta ocupacional e afins', { until: 2023, note: 'Desde 2024, use 230 (fonoaudiólogo), 231 (fisioterapeuta) ou 232 (terapeuta ocupacional).' }),
      c('230', 'Fonoaudiólogo', { from: 2024 }),
      c('231', 'Fisioterapeuta', { from: 2024 }),
      c('232', 'Terapeuta ocupacional', { from: 2024 }),
      c('241', 'Advogado'),
      c('250', 'Sociólogo e cientista político'),
      c('251', 'Antropólogo e arqueólogo'),
      c('252', 'Economista, administrador, contador, auditor e afins'),
      c('253', 'Profissional de marketing, de publicidade e de comercialização'),
      c('254', 'Psicanalista'),
      c('255', 'Psicólogo'),
      c('256', 'Geógrafo'),
      c('257', 'Historiador'),
      c('258', 'Assistente social e economista doméstico'),
      c('259', 'Filósofo'),
      c('261', 'Jornalista e repórter'),
      c('263', 'Sacerdote ou membro de ordens ou seitas religiosas'),
      c('264', 'Tradutor, intérprete, filólogo'),
      c('265', 'Bibliotecário, documentalista, arquivólogo, museólogo'),
      c('266', 'Escritor, crítico, redator'),
      c('271', 'Locutor, comentarista'),
      c('272', 'Ator, diretor de espetáculos'),
      c('273', 'Cantor e compositor'),
      c('274', 'Músico, arranjador, regente de orquestra ou coral'),
      c('275', 'Desenhista industrial (designer), escultor, pintor artístico e afins'),
      c('276', 'Cenógrafo, decorador de interiores'),
      c('277', 'Empresário e produtor de espetáculos'),
      c('279', 'Outros profissionais do espetáculo e das artes'),
      c('290', 'Professor na educação infantil'),
      c('291', 'Professor do ensino fundamental'),
      c('292', 'Professor do ensino médio'),
      c('293', 'Professor do ensino profissional'),
      c('294', 'Professor do ensino superior'),
      c('295', 'Instrutor e professor de escolas livres'),
      c('296', 'Pedagogo, orientador educacional'),
      c('311', 'Técnico em ciências físicas e químicas'),
      c('312', 'Técnico em construção civil, de edificações e obras de infra-estrutura'),
      c('313', 'Técnico em eletro-eletrônica e fotônica'),
      c('314', 'Técnico em metalmecânica'),
      c('316', 'Técnico em mineralogia e geologia'),
      c('317', 'Técnico em informática'),
      c('318', 'Desenhista técnico e modelista'),
      c('319', 'Outros técnicos de nível médio das ciências físicas, químicas, engenharia e afins'),
      c('320', 'Técnico em biologia'),
      c('321', 'Técnico da produção agropecuária'),
      c('322', 'Técnico da ciência da saúde humana'),
      c('323', 'Técnico da ciência da saúde animal'),
      c('324', 'Técnico de laboratório, Raios-X e outros equipamentos e instrumentos de diagnóstico'),
      c('325', 'Técnico de bioquímica e da biotecnologia'),
      c('328', 'Técnico de conservação, dissecação e empalhamento de corpos'),
      c('351', 'Técnico das ciências administrativas e contábeis'),
      c('352', 'Técnico de inspeção, fiscalização e coordenação administrativa'),
      c('353', 'Agente de Bolsa de Valores, câmbio e outros serviços financeiros'),
      c('354', 'Agente e representante comercial, corretor, leiloeiro e afins'),
      c('355', 'Corretor e Administrador de Imóveis'),
      c('371', 'Técnico de serviços culturais'),
      c('372', 'Cinegrafista, fotógrafo e outros técnicos em operação de máquinas de tratamento de dados'),
      c('373', 'Técnico em operação de estações de rádio e televisão'),
      c('374', 'Técnico em operação de aparelhos de sonorização, cenografia e projeção'),
      c('375', 'Decorador e vitrinista'),
      c('376', 'Apresentador, artistas de artes populares e modelos'),
      c('377', 'Atleta, desportista e afins'),
      c('391', 'Outros técnicos de nível médio'),
      c('410', 'Bancário, economiário, escriturário, secretário, assistente e auxiliar administrativo'),
      c('420', 'Trabalhador de atendimento ao público, caixa, despachante, recenseador e afins'),
      c('511', 'Comissário de bordo, guia de turismo, agente de viagem e afins'),
      c('512', 'Trabalhador dos serviços domésticos em geral'),
      c('513', 'Trabalhador dos serviços de hotelaria e alimentação'),
      c('514', 'Trabalhador dos serviços de administração, conservação e manutenção de edifícios'),
      c('515', 'Trabalhador dos serviços de saúde'),
      c('516', 'Trabalhador dos serviços de embelezamento e cuidados pessoais'),
      c('517', 'Trabalhador dos serviços de proteção e segurança (exceto militar)'),
      c('518', 'Motorista e condutor do transporte de passageiros (motorista de taxi, ônibus, pequena embarcação etc)'),
      c('519', 'Outros trabalhadores de serviços diversos'),
      c('529', 'Vendedor e prestador de serviços do comércio, ambulante, caixeiro-viajante e camelô'),
      c('610', 'Produtor na exploração agropecuária'),
      c('620', 'Trabalhador na exploração agropecuária'),
      c('630', 'Pescador, caçador e extrativista florestal'),
      c('640', 'Operador de máquina agropecuária e florestal'),
      c('710', 'Trabalhador da indústria extrativa e da construção civil'),
      c('720', 'Trabalhador da transformação de metais e compósitos'),
      c('730', 'Trabalhador da fabricação e instalação eletro-eletrônica'),
      c('740', 'Montador de aparelhos e instrumentos de precisão e musicais'),
      c('750', 'Joalheiro, vidreiro, ceramista e afins'),
      c('760', 'Trabalhador das indústrias têxteis, do curtimento, do vestuário e das artes gráficas'),
      c('770', 'Trabalhador das indústrias de madeira e do mobiliário'),
      c('780', 'Condutor e operador de robôs, veículos de equipamentos de movimentação de carga e afins'),
      c('810', 'Trabalhador das indústrias química, petroquímica, borracha e plástico e afins'),
      c('820', 'Trabalhador de instalações siderúrgicas e de materiais de construção'),
      c('830', 'Trabalhador de instalações e máquinas de fabricação de celulose e papel'),
      c('840', 'Trabalhador da fabricação de alimentos, bebidas, fumo e de agroindústrias'),
      c('860', 'Operador de instalações de produção e distribuição de energia'),
      c('870', 'Trabalhador de outras instalações agroindustriais'),
      c('900', 'Trabalhador de reparação e manutenção'),
      c('10', 'Militar da Aeronáutica'),
      c('20', 'Militar do Exército'),
      c('30', 'Militar da Marinha'),
      c('40', 'Policial Militar'),
      c('50', 'Bombeiro Militar'),
      c('0', 'Sem ocupações'),
    ],
  },
};

/** O código vale no ano-calendário? */
export const carneLeaoCodeValid = (code: CarneLeaoCode, calendarYear: number) =>
  (code.from === undefined || calendarYear >= code.from) && (code.until === undefined || calendarYear <= code.until);

/** Tabelas do ano-calendário, só com os códigos que valem nele (para a tela e a validação). */
export function carneLeaoTables(calendarYear: number) {
  return Object.fromEntries(
    Object.entries(CARNE_LEAO_TABLES).map(([key, t]) => [key, { label: t.label, codes: t.codes.filter((x) => carneLeaoCodeValid(x, calendarYear)) }]),
  ) as typeof CARNE_LEAO_TABLES;
}

const missing = (what: string, code: string, calendarYear: number, entry?: CarneLeaoCode) =>
  `${what} ${code} não existe na tabela do Carnê-Leão ${calendarYear}.${entry?.note ? ` ${entry.note}` : ''}`;

/**
 * Confere o código de rendimento ou de pagamento (já no formato) nas tabelas do ano: devolve a
 * mensagem do problema ou null. P10/P11 fora do plano de contas padrão são aceitos (plano próprio).
 */
export function carneLeaoCodeProblem(kind: CashbookKind, code: string, calendarYear: number): string | null {
  if (kind === 'payment' && /^P1[01]\./.test(code)) return null;
  const table = kind === 'income' ? CARNE_LEAO_TABLES.income : CARNE_LEAO_TABLES.generalPayment;
  const entry = table.codes.find((x) => x.code === code);
  return entry && carneLeaoCodeValid(entry, calendarYear) ? null : missing('Código', code, calendarYear, entry);
}

/** Confere o código de ocupação (só dígitos; "010" e "10" são o mesmo) na tabela do ano: mensagem ou null. */
export function carneLeaoOccupationProblem(occupation: string, calendarYear: number): string | null {
  const entry = CARNE_LEAO_TABLES.occupation.codes.find((x) => Number(x.code) === Number(occupation));
  return entry && carneLeaoCodeValid(entry, calendarYear) ? null : missing('Código de ocupação', occupation, calendarYear, entry);
}

// ---------------------------------------------------------------------------
// Conversão e validação
// ---------------------------------------------------------------------------
export interface CashbookEntryData {
  kind: CashbookKind;
  entryDate: string;
  code: string;
  description: string;
  valueCents: number;
  counterpartyCpf: string | null;
  extra: {
    occupationCode?: string | null;
    deductionCents?: number | null;
    receivedFrom?: 'PF' | 'PJ' | 'EX';
    beneficiaryCpf?: string | null;
    beneficiaryCpfMissing?: boolean;
    cnpj?: string | null;
    irrf?: boolean;
    irrfCents?: number | null;
    fineCents?: number | null;
    interestCents?: number | null;
    competence?: string | null;
  };
}

export type CashbookRowResult = { ok: true; entry: CashbookEntryData } | { ok: false; errors: string[] };

/** Normaliza cabeçalhos como `readSheet` (sem acento, minúsculo, com _). */
export const normalizeHeader = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** Primeira coluna preenchida entre os apelidos. */
const pickKey = (v: Record<string, string>, ...keys: string[]) => keys.find((k) => v[k] !== undefined && String(v[k]).trim() !== '');

const pick = (v: Record<string, string>, ...keys: string[]) => {
  const k = pickKey(v, ...keys);
  return k === undefined ? '' : String(v[k]).trim();
};

/**
 * Valor em reais digitado ou vindo de planilha/CSV → centavos. Parser único do sistema
 * (livro caixa, importação de orçamentos e demais planilhas):
 * - "R$ 1.500" e "1.500" → 150000 (ponto com grupos de 3 dígitos é milhar);
 * - "1.500,50", "1500,50" e "1,5" → vírgula decimal;
 * - "1500.5" e "1.50" → ponto decimal (sem grupos de milhar);
 * - "1,500.50" → formato americano com milhar e decimal;
 * - ambíguos ou malformados devolvem null: "1,500" (milhar americano ou 3 casas?), "1.500.5",
 *   "1.500,00,0", texto.
 * Só para texto. Célula numérica de .xlsx tem o número cru (`readSheet` → `numbers`) e vai por
 * `toCents`: o texto dela usa ponto decimal ("104.895" = R$ 104,90) e seria lido como milhar.
 */
export function parseBrMoney(v: string): number | null {
  const s = String(v ?? '').replace(/R\$|\s/g, '');
  if (!s) return null;
  const m = /^(-?)([\d.,]+)$/.exec(s);
  if (!m) return null;
  const [, sign, body] = m;
  let normalized: string | null = null;
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // os dois separadores: o último é o decimal e o outro precisa formar grupos de milhar
    if (lastComma > lastDot && /^\d{1,3}(\.\d{3})+,\d+$/.test(body)) normalized = body.replace(/\./g, '').replace(',', '.');
    else if (lastDot > lastComma && /^\d{1,3}(,\d{3})+\.\d+$/.test(body)) normalized = body.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "1,500" pode ser milhar americano ou 1,5 com 3 casas: ambíguo
    if (/^\d{1,3},\d{3}$/.test(body)) normalized = null;
    else if (/^\d+,\d+$/.test(body)) normalized = body.replace(',', '.');
    else if (/^\d{1,3}(,\d{3}){2,}$/.test(body)) normalized = body.replace(/,/g, '');
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(body)) normalized = body.replace(/\./g, '');
    else if (/^\d*\.\d+$/.test(body)) normalized = body;
  } else normalized = body;
  if (normalized === null) return null;
  const n = Number(`${sign}${normalized}`);
  return Number.isFinite(n) ? toCents(n) : null;
}

/** "31/12/2025" ou "2025-12-31" → "2025-12-31" (valida o dia). */
export function parseBrDate(v: string): string | null {
  const t = v.trim();
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const [y, m, d] = br ? [Number(br[3]), Number(br[2]), Number(br[1])] : iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [0, 0, 0];
  if (!y) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const INCOME_CODE_RE = /^R\d{2}\.\d{3}\.\d{3}$/;
export const PAYMENT_CODE_RE = /^P\d{2}\.\d{2}\.\d{5}$/;

/** Detecta pelo cabeçalho se a planilha é de rendimentos ou de pagamentos. */
export function detectCashbookKind(headers: string[]): CashbookKind | null {
  const h = new Set(headers.map(normalizeHeader));
  if (h.has('codigo_do_rendimento') || h.has('valor_recebido') || h.has('recebido_de')) return 'income';
  if (h.has('codigo_do_pagamento') || h.has('valor_pago')) return 'payment';
  return null;
}

/**
 * Valida uma linha (valores com cabeçalhos normalizados) e devolve o lançamento ou os erros.
 * `numbers` traz o número cru das células numéricas do .xlsx (mesmas chaves de `values`); os
 * valores em reais saem dele quando houver, e do texto (`parseBrMoney`) nos demais casos.
 */
export function parseCashbookRow(
  kind: CashbookKind,
  values: Record<string, string>,
  calendarYear: number,
  numbers: Record<string, number> = {},
): CashbookRowResult {
  const errors: string[] = [];
  /** Coluna de valor: texto para mensagens e centavos (número cru da célula ou texto). */
  const moneyCell = (...keys: string[]) => {
    const key = pickKey(values, ...keys);
    if (key === undefined) return { raw: '', cents: null };
    const n = numbers[key];
    return { raw: String(values[key]).trim(), cents: typeof n === 'number' && Number.isFinite(n) ? toCents(n) : parseBrMoney(values[key]) };
  };
  const rawDate = pick(values, 'data', 'data_de_recebimento', 'data_do_recebimento', 'data_do_pagamento');
  if (rawDate === '99/99/9999') return { ok: false, errors: ['Linha do modelo não preenchida: troque 99/99/9999 pela data ou apague a linha.'] };
  const date = rawDate ? parseBrDate(rawDate) : null;
  if (!rawDate) errors.push('Data obrigatória.');
  else if (!date) errors.push(`Data inválida: "${rawDate}" (use DD/MM/AAAA).`);
  else if (Number(date.slice(0, 4)) !== calendarYear) errors.push(`Data fora do ano-calendário ${calendarYear}.`);

  const code = pick(values, kind === 'income' ? 'codigo_do_rendimento' : 'codigo_do_pagamento', 'codigo')
    .toUpperCase()
    .replace(/\s+/g, '');
  const codeRe = kind === 'income' ? INCOME_CODE_RE : PAYMENT_CODE_RE;
  const codeProblem = code && codeRe.test(code) ? carneLeaoCodeProblem(kind, code, calendarYear) : null;
  if (!code) errors.push(`Código do ${kind === 'income' ? 'rendimento' : 'pagamento'} obrigatório.`);
  else if (!codeRe.test(code)) errors.push(`Código "${code}" fora do formato ${kind === 'income' ? 'R00.000.000' : 'P00.00.00000'}.`);
  else if (codeProblem) errors.push(codeProblem);

  const { raw: rawValue, cents: value } = moneyCell(kind === 'income' ? 'valor_recebido' : 'valor_pago', 'valor');
  if (!rawValue) errors.push('Valor obrigatório.');
  else if (value === null) errors.push(`Valor inválido: "${rawValue}".`);
  else if (value <= 0) errors.push('O valor deve ser maior que zero.');

  const description = pick(values, 'historico', 'descricao').replace(/[\r\n]+/g, ' ');
  if (!description) errors.push('Histórico obrigatório.');
  else if (description.length > CARNE_LEAO_HISTORY_MAX) errors.push(`Histórico com mais de ${CARNE_LEAO_HISTORY_MAX} caracteres (limite do Carnê-Leão Web).`);

  const money = (label: string, ...keys: string[]) => {
    const { raw, cents: c } = moneyCell(...keys);
    if (!raw) return null;
    if (c === null || c < 0) {
      errors.push(`${label} inválido: "${raw}".`);
      return null;
    }
    return c;
  };

  if (kind === 'payment') {
    const fine = money('Valor da multa', 'valor_da_multa', 'multa');
    const interest = money('Valor dos juros', 'valor_dos_juros', 'juros');
    const competenceRaw = pick(values, 'competencia');
    let competence: string | null = null;
    if (competenceRaw && competenceRaw !== '99/9999') {
      const m = /^(\d{1,2})\/(\d{4})$/.exec(competenceRaw);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) errors.push(`Competência inválida: "${competenceRaw}" (use MM/AAAA).`);
      else competence = `${m[1].padStart(2, '0')}/${m[2]}`;
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      entry: { kind, entryDate: date!, code, description, valueCents: value!, counterpartyCpf: null, extra: { fineCents: fine, interestCents: interest, competence } },
    };
  }

  const occupation = pick(values, 'codigo_de_ocupacao', 'ocupacao');
  if (occupation && !/^\d{1,4}$/.test(occupation)) errors.push(`Código de ocupação inválido: "${occupation}".`);
  else if (occupation) {
    const problem = carneLeaoOccupationProblem(occupation, calendarYear);
    if (problem) errors.push(problem);
    // modelo oficial de serviços notariais e de registro: ocupação 117 (titular de cartório)
    else if (code === 'R01.001.002' && Number(occupation) !== 117) errors.push('Para serviços notariais e de registro (R01.001.002), o código de ocupação é 117 (titular de cartório).');
  }
  if (!occupation && code.startsWith('R01.001')) errors.push('Código de ocupação obrigatório para este código de rendimento.');
  const deduction = money('Valor de dedução', 'valor_de_deducao', 'deducao');
  if (deduction !== null && value !== null && deduction > value) errors.push('A dedução não pode ser maior que o valor recebido.');

  const fromRaw = pick(values, 'recebido_de', 'origem').toUpperCase();
  const from = (
    { PF: 'PF', 'PESSOA FISICA': 'PF', 'PESSOA FÍSICA': 'PF', PJ: 'PJ', 'PESSOA JURIDICA': 'PJ', 'PESSOA JURÍDICA': 'PJ', EX: 'EX', EXTERIOR: 'EX' } as Record<string, 'PF' | 'PJ' | 'EX'>
  )[fromRaw];
  if (!fromRaw) errors.push('Informe "Recebido de" (PF, PJ ou EX).');
  else if (!from) errors.push(`"Recebido de" inválido: "${fromRaw}" (use PF, PJ ou EX).`);

  const payerCpfRaw = pick(values, 'cpf_do_titular_do_pagamento', 'cpf_do_titular', 'cpf_do_pagador');
  const beneficiaryRaw = pick(values, 'cpf_do_beneficiario', 'cpf_do_beneficiario_do_servico');
  const missing = /^s/i.test(pick(values, 'cpf_do_beneficiario_nao_informado', 'indicador_de_cpf_nao_informado'));
  const cnpjRaw = pick(values, 'cnpj', 'cnpj_da_fonte_pagadora');
  const irrfFlag = pick(values, 'houve_irrf', 'indicador_de_irrf').toUpperCase();
  const irrfValue = money('Valor do IRRF', 'valor_do_irrf', 'irrf');

  const payerCpf = onlyDigits(payerCpfRaw);
  const beneficiaryCpf = onlyDigits(beneficiaryRaw);
  const cnpj = onlyDigits(cnpjRaw);
  if (from === 'PF') {
    if (!payerCpf) errors.push('CPF do titular do pagamento obrigatório para rendimento de pessoa física.');
    else if (!isValidCpf(payerCpf)) errors.push(`CPF do titular inválido: "${payerCpfRaw}".`);
    if (beneficiaryCpf && !isValidCpf(beneficiaryCpf)) errors.push(`CPF do beneficiário inválido: "${beneficiaryRaw}".`);
    if (code === 'R01.001.001' && !beneficiaryCpf && !missing) errors.push('Informe o CPF do beneficiário do serviço ou marque "CPF do beneficiário não informado" com S.');
  }
  let irrf = false;
  if (from === 'PJ') {
    if (!cnpj) errors.push('CNPJ obrigatório para rendimento de pessoa jurídica.');
    else if (!isValidCnpj(cnpj)) errors.push(`CNPJ inválido: "${cnpjRaw}".`);
    if (irrfFlag && !['S', 'N'].includes(irrfFlag)) errors.push('"Houve IRRF" deve ser S ou N.');
    irrf = irrfFlag === 'S';
    if (irrf && !irrfValue) errors.push('Informe o valor do IRRF.');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      kind,
      entryDate: date!,
      code,
      description,
      valueCents: value!,
      counterpartyCpf: from === 'PF' ? payerCpf : null,
      extra: {
        occupationCode: occupation || null,
        deductionCents: deduction,
        receivedFrom: from,
        beneficiaryCpf: from === 'PF' ? beneficiaryCpf || null : null,
        beneficiaryCpfMissing: from === 'PF' && !beneficiaryCpf && missing,
        cnpj: from === 'PJ' ? cnpj : null,
        irrf: from === 'PJ' ? irrf : undefined,
        irrfCents: from === 'PJ' && irrf ? irrfValue : null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Exportação para o Carnê-Leão Web
// ---------------------------------------------------------------------------
const fmtMoney = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ','));
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const clean = (s: string) => s.replace(/[;\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** Linha no layout de importação de escrituração do Carnê-Leão Web. */
export function carneLeaoLine(e: Pick<CashbookEntryData, 'kind' | 'entryDate' | 'code' | 'description' | 'valueCents' | 'counterpartyCpf' | 'extra'>): string {
  const x = e.extra ?? {};
  if (e.kind === 'payment') {
    const base = [fmtDate(e.entryDate), e.code, fmtMoney(e.valueCents), clean(e.description)];
    if (!e.code.startsWith('P20')) return base.join(';');
    return [...base, fmtMoney(x.fineCents), fmtMoney(x.interestCents), x.competence ?? ''].join(';');
  }
  const from = x.receivedFrom ?? 'PF';
  const cells = [
    fmtDate(e.entryDate),
    e.code,
    x.occupationCode ?? '',
    fmtMoney(e.valueCents),
    fmtMoney(x.deductionCents),
    clean(e.description),
    from,
    from === 'PF' ? (e.counterpartyCpf ?? '') : '',
    from === 'PF' ? (x.beneficiaryCpf ?? '') : '',
    from === 'PF' && x.beneficiaryCpfMissing ? 'S' : '',
    from === 'PJ' ? (x.cnpj ?? '') : '',
    from === 'PJ' ? (x.irrf ? 'S' : 'N') : '',
    from === 'PJ' && x.irrf ? fmtMoney(x.irrfCents) : '',
  ];
  // os modelos oficiais omitem os campos vazios do fim da linha (mínimo de 7 campos)
  while (cells.length > 7 && cells[cells.length - 1] === '') cells.pop();
  return cells.join(';');
}

/** Arquivos CSV para importação (até 1.000 linhas cada), em ordem de data. */
export function carneLeaoFiles(entries: Parameters<typeof carneLeaoLine>[0][], baseName: string): { filename: string; content: string }[] {
  const sorted = [...entries].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  const files: { filename: string; content: string }[] = [];
  for (let i = 0; i < sorted.length; i += CASHBOOK_MAX_ROWS) {
    const part = sorted.slice(i, i + CASHBOOK_MAX_ROWS);
    const n = files.length + 1;
    const filename = sorted.length > CASHBOOK_MAX_ROWS ? `${baseName}-parte-${n}.csv` : `${baseName}.csv`;
    files.push({ filename, content: part.map(carneLeaoLine).join('\r\n') + '\r\n' });
  }
  return files;
}

export interface CashbookMonth {
  month: number;
  incomeCents: number;
  deductionCents: number;
  irrfCents: number;
  /** Despesas dedutíveis do livro caixa (códigos P10). */
  deductibleCents: number;
  /** Despesas não dedutíveis (P11). */
  nonDeductibleCents: number;
  /** Pagamentos gerais (P20: previdência, pensão, imposto). */
  generalPaymentsCents: number;
  count: number;
}

/** Totais por mês (1 a 12). */
export function cashbookByMonth(entries: { kind: string; entryDate: string; code: string; valueCents: number; extra?: Record<string, unknown> | null }[]): CashbookMonth[] {
  const months: CashbookMonth[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    incomeCents: 0,
    deductionCents: 0,
    irrfCents: 0,
    deductibleCents: 0,
    nonDeductibleCents: 0,
    generalPaymentsCents: 0,
    count: 0,
  }));
  for (const e of entries) {
    const m = months[Number(e.entryDate.slice(5, 7)) - 1];
    if (!m) continue;
    m.count++;
    const extra = (e.extra ?? {}) as CashbookEntryData['extra'];
    if (e.kind === 'income') {
      m.incomeCents += e.valueCents;
      m.deductionCents += extra.deductionCents ?? 0;
      m.irrfCents += extra.irrfCents ?? 0;
    } else if (e.code.startsWith('P10')) m.deductibleCents += e.valueCents;
    else if (e.code.startsWith('P11')) m.nonDeductibleCents += e.valueCents;
    else m.generalPaymentsCents += e.valueCents;
  }
  return months;
}
