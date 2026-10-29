import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: 100_000,
  });

  // Placeholder: no auth and no game events yet (added in Step 4).
  io.on('connection', (socket) => {
    logger.info(`socket connected: ${socket.id}`);
    socket.on('disconnect', (reason) => {
      logger.info(`socket disconnected: ${socket.id} (${reason})`);
    });
  });

  return io;
}