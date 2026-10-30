import type { Server } from 'socket.io';
import type { Notifier } from '../rooms/roomManager.js';

/** Delivers messages to every socket a user has open (they all join the room "user:<id>"). */
export class SocketNotifier implements Notifier {
  private io: Server | null = null;

  attach(io: Server): void {
    this.io = io;
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.io?.to(`user:${userId}`).emit(event, payload);
  }
}
