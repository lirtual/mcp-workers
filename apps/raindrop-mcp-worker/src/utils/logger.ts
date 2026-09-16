/** Worker-native structured logging with credential redaction. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEY = /(authorization|token|secret|password|api[-_]?key)/i;
const REDACTED = "[REDACTED]";

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(authorization|token|secret|password|api[-_]?key)\s*([:=])\s*([^\s,;}]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${REDACTED}`,
    );
}

function serializeLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return JSON.stringify(
      {
        name: arg.name,
        message: redactSensitiveText(arg.message),
        stack: arg.stack ? redactSensitiveText(arg.stack) : undefined,
        cause:
          typeof arg.cause === "string"
            ? redactSensitiveText(arg.cause)
            : arg.cause,
      },
      null,
      2,
    );
  }

  if (typeof arg === "string") {
    return redactSensitiveText(arg);
  }

  if (typeof arg === "object" && arg !== null) {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(
        arg,
        (key, value: unknown) => {
          if (key && SENSITIVE_KEY.test(key)) return REDACTED;
          if (typeof value === "string") return redactSensitiveText(value);
          if (typeof value === "object" && value !== null) {
            if (seen.has(value)) return "[Circular]";
            seen.add(value);
          }
          return value;
        },
        2,
      );
    } catch {
      return redactSensitiveText(String(arg));
    }
  }

  return redactSensitiveText(String(arg));
}

class Logger {
  private level: LogLevel;
  private readonly context?: string;

  constructor(level: LogLevel = "info", context?: string) {
    this.level = level;
    this.context = context;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const levelLabel = level.toUpperCase().padEnd(5);
    const context = this.context ? `[${this.context}] ` : "";
    const line = `[${timestamp}] ${levelLabel} ${context}${redactSensitiveText(message)}`;
    const serializedArgs = args.map(serializeLogArg);

    switch (level) {
      case "debug":
        globalThis.console.debug(line, ...serializedArgs);
        break;
      case "info":
        globalThis.console.info(line, ...serializedArgs);
        break;
      case "warn":
        globalThis.console.warn(line, ...serializedArgs);
        break;
      case "error":
        globalThis.console.error(line, ...serializedArgs);
        break;
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write("debug", message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write("info", message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write("error", message, ...args);
  }

  child(context: string): Logger {
    const nestedContext = this.context ? `${this.context}:${context}` : context;
    return new Logger(this.level, nestedContext);
  }
}

export const logger = new Logger();

export function createLogger(context?: string): Logger {
  return context ? logger.child(context) : logger;
}
