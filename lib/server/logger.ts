/**
 * Server-side structured logger (pino). ONE logging strategy for every
 * Node-side code path (API routes, decision client, persistence):
 *
 *  - dev:  human-readable, colorized, timestamped single lines (pino-pretty
 *          used as a synchronous transform stream — no worker thread, which
 *          is fragile inside Next's webpack server bundle).
 *  - prod: newline-delimited JSON on stdout, machine-parseable.
 *
 * Level comes from LOG_LEVEL (default: debug in dev, info in prod).
 * Client code (hooks/, components/, browser-side lib/) must NOT import this
 * module — pino stays out of the browser bundle; client debug spam was
 * removed outright instead.
 */
import pino from "pino";
import pinoPretty from "pino-pretty";

const isProd = process.env.NODE_ENV === "production";

const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

const options: pino.LoggerOptions = {
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined, // drop pid/hostname — this is a single local process
};

// pino-pretty returns a synchronous Transform; passing it as the destination
// keeps dev output pretty without spawning a transport worker thread.
const destination = isProd
  ? undefined
  : pinoPretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
      singleLine: true,
    });

export const logger = pino(options, destination);

/** Namespaced child logger, e.g. childLogger("api/chat"). */
export function childLogger(name: string): pino.Logger {
  return logger.child({ name });
}
