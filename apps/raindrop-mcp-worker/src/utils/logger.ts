/**
 * MCP-safe logging utilities
 *
 * This module provides logging that never pollutes STDIO output, which is critical
 * for MCP protocol compliance when using STDIO transport.
 *
 * - Uses stderr for all log output (STDIO transport uses stdout)
 * - Provides structured logging with timestamps and levels
 * - Can be safely used in both STDIO and HTTP server contexts
 * - Supports environment-based log level configuration
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function serializeLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return JSON.stringify(
      {
        name: arg.name,
        message: arg.message,
        stack: arg.stack,
        cause: arg.cause,
      },
      null,
      2,
    );
  }

  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }

  return String(arg);
}

/**
 * Logger class for MCP-safe logging.
 *
 * All log output is sent to stderr to avoid interfering with STDIO protocol communication.
 * Log level can be set via the LOG_LEVEL environment variable.
 */
class Logger {
  private level: LogLevel;

  constructor() {
    this.level = (process.env.LOG_LEVEL as LogLevel) || "info";
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private writeToStderr(level: LogLevel, message: string, ...args: any[]) {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const levelStr = level.toUpperCase().padEnd(5);
    const prefix = `[${timestamp}] ${levelStr}`;

    process.stderr.write(`${prefix} ${message}\n`);
    for (const arg of args) {
      process.stderr.write(`${prefix} ${serializeLogArg(arg)}\n`);
    }
  }

  debug(message: string, ...args: any[]) {
    this.writeToStderr("debug", message, ...args);
  }

  info(message: string, ...args: any[]) {
    this.writeToStderr("info", message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.writeToStderr("warn", message, ...args);
  }

  error(message: string, ...args: any[]) {
    this.writeToStderr("error", message, ...args);
  }

  child(context: string): Logger {
    const childLogger = new Logger();
    childLogger.level = this.level;
    const originalWrite = childLogger.writeToStderr.bind(childLogger);
    childLogger.writeToStderr = (
      level: LogLevel,
      message: string,
      ...args: any[]
    ) => {
      originalWrite(level, `[${context}] ${message}`, ...args);
    };
    return childLogger;
  }
}

export const logger = new Logger();

export function createLogger(context?: string): Logger {
  return context ? logger.child(context) : logger;
}
