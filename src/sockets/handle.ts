import type { Socket } from 'socket.io';
import { z } from 'zod';
import { err, type Result } from '../rooms/types.js';
import { logger } from '../utils/logger.js';

/** Sliding window: at most `max` events per `windowMs` for one socket. */
export class RateLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly max = 40,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  allow(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(t);
    return true;
  }
}

export type Handler = <S extends z.ZodType>(
  event: string,
  schema: S,
  fn: (data: z.output<S>) => Result<unknown> | Promise<Result<unknown>>,
) => void;

/**
 * Registers a socket event with rate limiting, payload validation and error handling.
 * Every handler answers through the client's acknowledgement callback: { ok, data? } or { ok: false, code, message }.
 */
export function createHandler(socket: Socket, limiter: RateLimiter): Handler {
  return (event, schema, fn) => {
    socket.on(event, (...args: unknown[]) => {
      // emit('event', ack) with no payload: the callback arrives first.
      const last = args[args.length - 1];
      const ack = typeof last === 'function' ? (last as (reply: unknown) => void) : undefined;
      const reply = (result: unknown): void => {
        if (ack) ack(result);
      };

      void (async () => {
        if (!limiter.allow()) {
          reply(err('RATE_LIMITED', 'You are sending too many requests. Slow down.'));
          return;
        }
        const parsed = schema.safeParse(typeof args[0] === 'function' ? undefined : args[0]);
        if (!parsed.success) {
          reply(err('VALIDATION', z.prettifyError(parsed.error)));
          return;
        }
        try {
          reply(await fn(parsed.data));
        } catch (error) {
          logger.error(`Handler ${event} crashed`, error);
          reply(err('INTERNAL', 'Something went wrong on the server.'));
        }
      })();
    });
  };
}
