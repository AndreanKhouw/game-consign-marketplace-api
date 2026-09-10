import { buildApp } from './app.js';
import { loadConfig } from './platform/config.js';

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutdown started');
  const forceTimer = setTimeout(() => process.exit(1), 15_000);
  forceTimer.unref();
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forceTimer);
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  await app.close();
  process.exitCode = 1;
}
