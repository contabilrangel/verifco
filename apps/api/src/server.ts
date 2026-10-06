import { buildApp } from './app';
import { createContext } from './bootstrap';

const { ctx, close } = await createContext();
const app = await buildApp(ctx, { logger: true });
if (ctx.config.RUN_WORKER) ctx.jobs.start();

const shutdown = async () => {
  ctx.jobs.stop();
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: ctx.config.PORT, host: ctx.config.HOST });
