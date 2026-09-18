export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface CronField {
  wildcard: boolean;
  values: readonly number[];
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Schedule cron must contain exactly five fields.');
  }

  return {
    minute: parseField(fields[0]!, 0, 59, false),
    hour: parseField(fields[1]!, 0, 23, false),
    dayOfMonth: parseField(fields[2]!, 1, 31, false),
    month: parseField(fields[3]!, 1, 12, false),
    dayOfWeek: parseField(fields[4]!, 0, 7, true)
  };
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid schedule timezone "${timeZone}".`);
  }
}

export function latestDueOccurrence(input: {
  cron: string;
  timezone?: string;
  fromExclusive: number;
  toInclusive: number;
  maxLookbackDays?: number;
}): number | null {
  const parsed = parseCronExpression(input.cron);
  const timezone = input.timezone ?? 'UTC';
  validateTimeZone(timezone);

  const toMinute = Math.floor(input.toInclusive / 60_000) * 60_000;
  const fromMinute = Math.floor(input.fromExclusive / 60_000) * 60_000;
  if (toMinute <= fromMinute) return null;

  const end = zonedParts(toMinute, timezone);
  const start = zonedParts(fromMinute, timezone);
  const maxLookbackDays = input.maxLookbackDays ?? 366;
  let cursor = localDateOrdinal(end.year, end.month, end.day);
  const first = Math.max(
    localDateOrdinal(start.year, start.month, start.day),
    cursor - maxLookbackDays
  );

  for (; cursor >= first; cursor -= 1) {
    const date = ordinalToLocalDate(cursor);
    if (!matchesDate(parsed, date.year, date.month, date.day)) continue;

    for (let hourIndex = parsed.hour.values.length - 1; hourIndex >= 0; hourIndex -= 1) {
      const hour = parsed.hour.values[hourIndex]!;
      for (let minuteIndex = parsed.minute.values.length - 1; minuteIndex >= 0; minuteIndex -= 1) {
        const minute = parsed.minute.values[minuteIndex]!;
        const candidate = zonedLocalToEpoch(
          { year: date.year, month: date.month, day: date.day, hour, minute },
          timezone
        );
        if (candidate === null || candidate > toMinute || candidate <= fromMinute) continue;
        return candidate;
      }
    }
  }

  return null;
}

function parseField(source: string, min: number, max: number, normalizeSunday: boolean): CronField {
  const wildcard = source === '*' || source.startsWith('*/');
  const values = new Set<number>();

  for (const part of source.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}".`);

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart?.includes('-')) {
      const [left, right] = rangePart.split('-');
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = start;
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Invalid cron field "${source}".`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }

  return { wildcard, values: [...values].sort((a, b) => a - b) };
}

function matchesDate(parsed: ParsedCron, year: number, month: number, day: number): boolean {
  if (!parsed.month.values.includes(month)) return false;

  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domMatch = parsed.dayOfMonth.values.includes(day);
  const dowMatch = parsed.dayOfWeek.values.includes(dayOfWeek);

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dowMatch;
  if (parsed.dayOfWeek.wildcard) return domMatch;
  return domMatch || dowMatch;
}

function localDateOrdinal(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function ordinalToLocalDate(ordinal: number): { year: number; month: number; day: number } {
  const date = new Date(ordinal * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function zonedLocalToEpoch(parts: ZonedParts, timezone: string): number | null {
  const desiredWall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = desiredWall;

  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(guess, timezone);
    const actualWall = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute
    );
    const difference = desiredWall - actualWall;
    if (difference === 0) {
      const verified = zonedParts(guess, timezone);
      return sameWallTime(verified, parts) ? Math.floor(guess / 60_000) * 60_000 : null;
    }
    guess += difference;
  }

  const verified = zonedParts(guess, timezone);
  return sameWallTime(verified, parts) ? Math.floor(guess / 60_000) * 60_000 : null;
}

function sameWallTime(left: ZonedParts, right: ZonedParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function zonedParts(epochMs: number, timezone: string): ZonedParts {
  const formatter = getFormatter(timezone);
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}
