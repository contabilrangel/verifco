/** Espera crescente entre tentativas: `baseMs`, o dobro, o dobro… até `maxMs`. */
export interface BackoffSchedule {
  baseMs: number;
  maxMs: number;
}

/** Conexão ao iniciar: 5 s, 10 s, 20 s… até 5 minutos (e segue tentando para sempre). */
export const STARTUP_BACKOFF: BackoffSchedule = { baseMs: 5_000, maxMs: 5 * 60_000 };
/** Falha de conexão, de leitura do arquivo ou erro do servidor (5xx): 1 minuto… até 15 minutos. */
export const TRANSIENT_BACKOFF: BackoffSchedule = { baseMs: 60_000, maxMs: 15 * 60_000 };
/** Depende de alguém agir no Verifco (cliente não cadastrado, arquivo recusado): 15 minutos… até 2 horas. */
export const WAITING_BACKOFF: BackoffSchedule = { baseMs: 15 * 60_000, maxMs: 2 * 60 * 60_000 };
/** Voltar a observar uma pasta depois de um erro do observador: 30 s… até 5 minutos. */
export const REARM_BACKOFF: BackoffSchedule = { baseMs: 30_000, maxMs: 5 * 60_000 };

/** Espera antes da próxima tentativa; `attempt` começa em 0 (primeira nova tentativa). */
export function backoffDelay(attempt: number, schedule: BackoffSchedule): number {
  const n = Math.max(0, Math.floor(attempt) || 0);
  // 2^n estoura rápido: acima de 30 dobras o teto já foi atingido para qualquer base razoável
  return Math.min(schedule.maxMs, n > 30 ? schedule.maxMs : schedule.baseMs * 2 ** n);
}

/** "30 segundos", "1 minuto", "2 horas" — para as mensagens do log. */
export function formatDelay(ms: number): string {
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (ms < 60_000) return unit(Math.max(1, Math.round(ms / 1000)), 'segundo', 'segundos');
  if (ms < 60 * 60_000) return unit(Math.round(ms / 60_000), 'minuto', 'minutos');
  return unit(Math.round(ms / (60 * 60_000)), 'hora', 'horas');
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
