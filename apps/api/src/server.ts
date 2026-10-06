import { buildApp } from './app';
import { createContext } from './bootstrap';

const { ctx, close } = await createContext();
const app = await buildApp(ctx, { logger: true });
if (ctx.config.RUN_WORKER) ctx.jobs.start();

/**
 * Desligamento gracioso (deploy, SIGTERM): para de pegar jobs novos, deixa terminar as requisições
 * e os jobs em andamento até SHUTDOWN_TIMEOUT_SECONDS e devolve à fila os que não terminaram, para
 * outro processo retomar. Só então fecha o banco. Um segundo sinal encerra na hora.
 */
let closing = false;
const shutdown = async (signal: string) => {
  if (closing) {
    app.log.warn(`${signal} de novo: encerrando sem esperar.`);
    process.exit(1);
  }
  closing = true;
  const timeoutMs = ctx.config.SHUTDOWN_TIMEOUT_SECONDS * 1000;
  app.log.info(`${signal} recebido: encerrando (aguarda até ${ctx.config.SHUTDOWN_TIMEOUT_SECONDS} s).`);
  // trava de segurança: se algo travar no fechamento, sai mesmo assim
  setTimeout(() => process.exit(1), timeoutMs + 10_000).unref();
  try {
    const jobsStopped = ctx.jobs.stop({ timeoutMs });
    await app.close();
    const { finished, released } = await jobsStopped;
    if (finished || released) app.log.info(`Fila de tarefas: ${finished} concluída(s), ${released} devolvida(s) à fila.`);
    await close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'erro ao encerrar');
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });
