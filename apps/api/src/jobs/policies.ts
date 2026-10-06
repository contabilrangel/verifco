import { JOB_PRIORITY, steppedBackoff, type JobTypeOptions } from './queue';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Integrações externas (Asaas/Omie): 1 min, 5 min, 30 min, 2 h, 6 h, 12 h e 24 h (teto), cerca de
 * dois dias de tentativas. Erros permanentes (credencial recusada, integração desligada) não repetem.
 */
export const INTEGRATION_BACKOFF = [1 * MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

/**
 * Prioridade e limites de cada tipo de job (a fila aplica no claim). Mensagens e cobranças saem na
 * frente; as tarefas longas ficam limitadas por escritório e nunca ocupam a última vaga do worker,
 * para um escritório não atrasar os envios dos outros. O módulo pode completar com
 * `ctx.jobs.register(tipo, executor, opções)` (ex.: `onFailed`).
 */
export const JOB_POLICIES: Record<string, JobTypeOptions> = {
  // envios ao cliente e à equipe; o limite por escritório deixa vaga para os outros numa mala direta
  // grande, e as tentativas cobrem uma queda de uns 40 minutos do servidor de e-mail ou do WhatsApp
  'delivery.send': { priority: JOB_PRIORITY.high, perOffice: 3, maxAttempts: 5, backoff: steppedBackoff([MIN / 2, 2 * MIN, 10 * MIN, 30 * MIN]) },
  'auth.password_reset': { priority: JOB_PRIORITY.high },
  'auth.lockout_notice': { priority: JOB_PRIORITY.high },
  'auth.email_changed': { priority: JOB_PRIORITY.high },
  'billing.sync_external': { priority: JOB_PRIORITY.high, maxAttempts: INTEGRATION_BACKOFF.length + 1, backoff: steppedBackoff(INTEGRATION_BACKOFF) },
  'mailing.deliver': { perOffice: 2 },
  'ai.financial_analysis': { perOffice: 2 },
  'omie.poll_payments': { perOffice: 1 },
  // um cliente por job (a sincronização do escritório pode ser dividida por cliente)
  'ecac.sync': { perOffice: 2 },
  // tarefas longas
  'backup.generate': { priority: JOB_PRIORITY.low, heavy: true, perOffice: 1 },
  'radar.compute': { priority: JOB_PRIORITY.low, heavy: true, perOffice: 1 },
  'ecac.sync_office': { priority: JOB_PRIORITY.low, heavy: true, perOffice: 1 },
  'elaboration.process_customer': { priority: JOB_PRIORITY.low, heavy: true, perOffice: 2 },
  'elaboration.export': { priority: JOB_PRIORITY.low, heavy: true, perOffice: 1 },
};
