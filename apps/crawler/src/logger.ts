import { pino } from 'pino';
import { loadConfig } from './config.js';

/**
 * Structured JSON logs. In CI they are parsed; locally pino-pretty renders
 * them, which is why the transport is only attached for a TTY.
 */
export const logger = pino({
  level: loadConfig().logLevel,
  // null omits pid and hostname; they are noise in a CI log.
  base: null,
  ...(process.stdout.isTTY
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }
    : {}),
});
