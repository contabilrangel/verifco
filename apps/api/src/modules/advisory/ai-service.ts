import ExcelJS from 'exceljs';
import { formatDate, todayIso } from '@verifco/shared';
import type { AppContext } from '../../context';
import type { AiCompletion, AiMessage } from '../../integrations/providers';
import { HttpError, badRequest } from '../../lib/errors';

/** Assistentes disponíveis e quem pode usá-los (todas as permissões listadas são exigidas). */
export const ASSISTANTS = {
  ir: { label: 'Especialista em IR', perms: ['ai.use'] },
  fine_mesh: { label: 'Especialista em Malha Fina', perms: ['ai.use'] },
  capital_gain: { label: 'Especialista em Ganho de Capital', perms: ['ai.use'] },
  irpfm: { label: 'Assistente do IRPFM', perms: ['ai.use', 'irpfm.view'] },
  copilot: { label: 'Copiloto Financeiro', perms: ['copilot.use'] },
} as const;
export type AssistantKey = keyof typeof ASSISTANTS;
export const ASSISTANT_KEYS = Object.keys(ASSISTANTS) as AssistantKey[];

/** Tempos limite das chamadas à IA (ajustáveis nos testes). */
export const AI_LIMITS = { chatTimeoutMs: 60_000, analysisTimeoutMs: 180_000 };
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** Regras comuns aos assistentes. Função, e não constante: a data de hoje (em Brasília) muda com o dia. */
const commonRules = () => `Regras:
- Responda em português do Brasil, de forma objetiva, para um contador (profissional da área).
- Fundamente com a legislação (lei, artigo, instrução normativa) e diga quando houver dúvida, divergência de interpretação ou necessidade de regulamentação.
- Use apenas os dados fornecidos e os anexos; quando faltar informação, diga o que precisa ser conferido. Não invente valores.
- Lembre que a resposta deve ser conferida pelo contador antes de qualquer uso com o cliente.
- Pontos legais recentes: a Lei 15.270/2025 instituiu, a partir do ano-calendário 2026 (declaração de 2027), a redução do IR para rendimentos até R$ 5 mil/mês, a retenção de 10% sobre lucros e dividendos acima de R$ 50 mil/mês de uma mesma empresa e a tributação mínima (IRPFM) para rendimentos totais acima de R$ 600 mil/ano (alíquota de 0% a 10% entre R$ 600 mil e R$ 1,2 milhão, com dedução do IR já pago e redutor pela carga da empresa).
- Hoje é ${formatDate(todayIso())}.`;

const PERSONAS: Record<AssistantKey, string> = {
  ir: 'Você é um especialista em Imposto de Renda da Pessoa Física (DIRPF) que apoia escritórios contábeis: rendimentos, deduções, bens e direitos, dependentes, carnê-leão, ganhos, atividade rural e obrigações acessórias.',
  fine_mesh:
    'Você é um especialista em malha fina da Receita Federal: analisa notificações e termos de intimação, aponta as prováveis divergências (DIRF, DMED, e-Financeira, DIMOB, carnê-leão), lista os documentos de comprovação e orienta entre retificação, autorregularização e impugnação (Decreto 70.235/1972).',
  capital_gain:
    'Você é um especialista em ganho de capital de pessoa física (GCAP): alienação de imóveis e bens, custo de aquisição, fatores de redução (Lei 11.196/2005, art. 40; Lei 7.713/1988, art. 18), isenções, alíquotas progressivas da Lei 13.259/2016, bens no exterior, renda variável e prazos do DARF.',
  irpfm:
    'Você é um especialista na tributação mínima do IRPF para altas rendas (IRPFM), instituída pela Lei 15.270/2025 (arts. 6º-A, 16-A e 16-B da Lei 9.250/1995): sujeição, base de cálculo e exclusões (incisos I a XII), alíquota, deduções do imposto já pago, redutor da carga da pessoa jurídica (34%, 40% ou 45%) e retenção de 10% sobre dividendos.',
  copilot:
    'Você é o copiloto financeiro do cliente, operado pelo escritório contábil: analisa receitas, despesas, orçamento, vencimentos, seguros e bens no exterior, aponta riscos e oportunidades e projeta efeitos tributários (inclusive o IRPFM).',
};

export function systemPrompt(assistant: AssistantKey, context: string) {
  return `${PERSONAS[assistant]}\n\n${commonRules()}\n\nContexto do cliente (dados do sistema do escritório):\n${context}`;
}

export const financialAdvisorPrompt = () => `Você é um assessor financeiro que trabalha junto a um escritório contábil. Analise os documentos anexados (extratos, faturas, informes, planilhas) e escreva uma análise em Markdown simples com as seções:
## Resumo
## Receitas e entradas
## Despesas e saídas
## Patrimônio, dívidas e investimentos
## Riscos e alertas
## Oportunidades e recomendações
## Pontos para o contador conferir
Use listas e valores em reais quando estiverem nos documentos. Não invente números. Termine lembrando que a análise deve ser conferida pelo contador.\n\n${commonRules()}`;

export const DEFENSE_PROMPT = `Redija a MINUTA de uma defesa administrativa (impugnação/esclarecimentos) relativa à malha fina do IRPF do cliente, com base na conversa, no contexto e nas observações do contador.
Estrutura: endereçamento (Delegacia da Receita Federal de Julgamento ou unidade indicada na notificação), qualificação do contribuinte usando exatamente os marcadores [NOME DO CONTRIBUINTE] e [CPF DO CONTRIBUINTE], dos fatos, do direito (com fundamentação legal), das provas (lista de documentos anexos), do pedido, local, data e assinatura.
Use marcadores entre colchetes para tudo que faltar (ex.: [número da notificação]). Texto puro, sem Markdown. Antes do texto, uma linha: "MINUTA — conferir antes de protocolar".`;

/** Erro claro quando a IA não está configurada, demora demais ou falha. */
export function aiError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { message?: string; code?: string; statusCode?: number; status?: number };
  const message = e?.message ?? String(err);
  if (e?.code === 'AI_NOT_CONFIGURED' || /n[aã]o (est[aá] )?configurad|not configured|api[ _-]?key|chave da api|credencia/i.test(message)) {
    return new HttpError(503, 'A inteligência artificial não está configurada para o escritório. Peça ao administrador para configurá-la em Administração › Integrações.');
  }
  return new HttpError(502, `A IA não conseguiu responder agora. Tente novamente em instantes. (${message.slice(0, 200)})`);
}

/** Chama o provedor de IA com tempo limite. */
export async function completeWithTimeout(
  ctx: AppContext,
  officeId: string,
  input: { system: string; messages: AiMessage[]; maxTokens?: number },
  timeoutMs = AI_LIMITS.chatTimeoutMs,
): Promise<AiCompletion> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, `A IA não respondeu em ${Math.round(timeoutMs / 1000)} segundos. Tente novamente ou reduza os anexos.`)), timeoutMs);
  });
  try {
    return await Promise.race([ctx.providers.ai.complete(officeId, input), timeout]);
  } catch (err) {
    throw aiError(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const MEDIA = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/;
const TEXT_LIMIT = 30_000;

export const decodeText = (data: Buffer) => {
  const utf8 = data.toString('utf8');
  return utf8.includes('�') ? data.toString('latin1') : utf8;
};

async function sheetToText(data: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    out.push(`# Planilha: ${ws.name}`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (c) => cells.push(String(c.text ?? '').trim()));
      out.push(cells.join(' | '));
    });
  }
  return out.join('\n');
}

/**
 * Converte arquivos do escritório em anexos da mensagem para a IA:
 * PDF e imagens vão como arquivo; CSV, TXT e XLSX viram texto.
 */
export async function attachmentsForAi(ctx: AppContext, officeId: string, fileIds: string[]) {
  const files: NonNullable<AiMessage['files']> = [];
  const texts: string[] = [];
  const names: { fileId: string; filename: string }[] = [];
  let total = 0;
  for (const id of fileIds) {
    const { row, data } = await ctx.files.get(officeId, id);
    total += data.length;
    if (total > 4 * MAX_ATTACHMENT_BYTES) throw badRequest('Os anexos somam mais de 60 MB. Envie menos arquivos.');
    names.push({ fileId: row.id, filename: row.filename });
    if (MEDIA.test(row.mimeType)) {
      files.push({ filename: row.filename, mimeType: row.mimeType, data });
    } else if (/\.xlsx$/i.test(row.filename)) {
      texts.push(`Conteúdo de ${row.filename}:\n${(await sheetToText(data)).slice(0, TEXT_LIMIT)}`);
    } else if (/\.(csv|txt)$/i.test(row.filename) || /^text\//.test(row.mimeType)) {
      texts.push(`Conteúdo de ${row.filename}:\n${decodeText(data).slice(0, TEXT_LIMIT)}`);
    } else {
      texts.push(`[O arquivo ${row.filename} (${row.mimeType}) não pode ser lido pela IA.]`);
    }
  }
  return { files, texts, names };
}
