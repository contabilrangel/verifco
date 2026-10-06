import { buildApp } from './app';
import { createContext } from './bootstrap';

/**
 * Prazo para as tarefas em andamento terminarem ao desligar (abaixo dos 10 s do `docker stop`);
 * as que não terminam voltam para a fila e a próxima instância continua.
 */
const SHUTDOWN_GRACE_MS = 8_000;

const { ctx, close } = await createContext();
const app = await buildApp(ctx, { logger: true });
if (ctx.config.RUN_WORKER) ctx.jobs.start();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // para de pegar tarefas e espera as que estão rodando antes de fechar o banco
  await ctx.jobs.stop({ graceMs: SHUTDOWN_GRACE_MS });
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });
