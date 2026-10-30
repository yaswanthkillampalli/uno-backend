import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { RoomManager } from '../rooms/roomManager.js';
import type { AuthUser } from '../rooms/types.js';
import { logger } from '../utils/logger.js';
import type { Authenticator } from './auth.js';
import { registerGameHandlers } from './gameHandlers.js';
import { createHandler, RateLimiter } from './handle.js';
import type { SocketNotifier } from './notifier.js';
import { registerRoomHandlers } from './roomHandlers.js';

export interface SocketDeps {
  manager: RoomManager;
  notifier: SocketNotifier;
  authenticate: Authenticator;
  corsOrigin: string[];
}

export function createSocketServer(httpServer: HttpServer, deps: SocketDeps): Server {
  const { manager, notifier, authenticate } = deps;
  const io = new Server(httpServer, {
    cors: { origin: deps.corsOrigin, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: 100_000,
  });
  notifier.attach(io);

  // Every connection must present a valid Supabase access token: io(url, { auth: { token } }).
  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    try {
      const user = await authenticate(token);
      if (!user) {
        next(new Error('UNAUTHORIZED'));
        return;
      }
      socket.data.user = user;
      next();
    } catch (error) {
      logger.error('Authentication service failed', error);
      next(new Error('AUTH_UNAVAILABLE'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    logger.info(`connected: ${user.username} (${socket.id})`);

    void socket.join(`user:${user.id}`);
    const on = createHandler(socket, new RateLimiter());
    registerRoomHandlers(on, manager, user);
    registerGameHandlers(on, manager, user);

    manager.connect(user.id); // also sends 'session:restore' with the user's room and game, if any

    socket.on('disconnect', (reason) => {
      logger.info(`disconnected: ${user.username} (${reason})`);
      manager.disconnect(user.id);
    });
  });

  return io;
}
