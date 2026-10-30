import { createServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './config/env.js';
import { RoomManager } from './rooms/roomManager.js';
import { SupabaseRoomRepo } from './rooms/supabaseRoomRepo.js';
import { cardsRouter } from './routes/cards.js';
import { healthRouter } from './routes/health.js';
import { createSocketServer } from './sockets/index.js';
import { SocketNotifier } from './sockets/notifier.js';
import { createSupabaseAuthenticator } from './sockets/supabaseAuth.js';
import { corsMiddleware } from './utils/cors.js';
import { logger } from './utils/logger.js';

if (!env.SUPABASE_SECRET_KEY.startsWith('sb_secret_')) {
  logger.warn(
    'SUPABASE_SECRET_KEY is not an sb_secret_ key. Legacy service_role keys are being retired; create a secret key in the Supabase dashboard.',
  );
}

const app = express();
app.disable('x-powered-by');
app.use(corsMiddleware(env.CLIENT_ORIGIN));
app.use(express.json({ limit: '10kb' }));
app.use(healthRouter);
app.use(cardsRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled HTTP error', err);
  res.status(500).json({ error: 'internal_error' });
});

const repo = new SupabaseRoomRepo();
const notifier = new SocketNotifier();
const manager = new RoomManager({ repo, notifier, graceMs: env.DISCONNECT_GRACE_SECONDS * 1000 });

const httpServer = createServer(app);
const io = createSocketServer(httpServer, {
  manager,
  notifier,
  authenticate: createSupabaseAuthenticator(repo),
  corsOrigin: env.CLIENT_ORIGIN,
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  logger.error(
    err.code === 'EADDRINUSE' ? `Port ${env.PORT} is already in use` : 'HTTP server error',
    err,
  );
  process.exit(1);
});

try {
  const restored = await manager.restore();
  logger.info(`Restored ${restored.rooms} room(s), ${restored.games} running game(s)`);
} catch (error) {
  logger.error('Could not restore rooms from the database. Did you run sql/schema.sql?', error);
  process.exit(1);
}

httpServer.listen(env.PORT, () => {
  logger.info(`Server listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`Allowed client origins: ${env.CLIENT_ORIGIN.join(', ')}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  void manager
    .shutdown() // stops timers and finishes pending database writes
    .catch((error: unknown) => logger.error('Shutdown flush failed', error))
    .finally(() => io.close(() => process.exit(0))); // also closes the HTTP server
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});
