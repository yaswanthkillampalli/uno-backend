import { createServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './config/env.js';
import { healthRouter } from './routes/health.js';
import { createSocketServer } from './sockets/index.js';
import { logger } from './utils/logger.js';

if (!env.SUPABASE_SECRET_KEY.startsWith('sb_secret_')) {
  logger.warn(
    'SUPABASE_SECRET_KEY is not an sb_secret_ key. Legacy service_role keys are being retired; create a secret key in the Supabase dashboard.',
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(healthRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled HTTP error', err);
  res.status(500).json({ error: 'internal_error' });
});

const httpServer = createServer(app);
const io = createSocketServer(httpServer);

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  logger.error(
    err.code === 'EADDRINUSE' ? `Port ${env.PORT} is already in use` : 'HTTP server error',
    err,
  );
  process.exit(1);
});

httpServer.listen(env.PORT, () => {
  logger.info(`Server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`Allowed client origins: ${env.CLIENT_ORIGIN.join(', ')}`);
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  io.close(() => process.exit(0)); // also closes the underlying HTTP server
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  process.exit(1);
});