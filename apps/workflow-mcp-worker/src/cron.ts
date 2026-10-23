// User schedules are matched here. The Worker itself keeps one UTC minute
// trigger; publish does not register another Cloudflare cron.
export const PLATFORM_CRON = '* * * * *';
export const CRON_CONTRACT = {
  format: 'Five fields separated by one space: minute hour day-of-month month day-of-week. minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-7 where 0 and 7 are Sunday and 1 is Monday. A field may be *, a number, a range, a step, or a comma list. If day-of-month and day-of-week are both restricted, either day matches. Names, a seconds field, timezone, and Quartz L, W, #, and ? are rejected. Quote the expression in YAML.',
  timezone: 'UTC' as const,
  dst: 'not_applicable' as const,
  minimum_interval_seconds: 60 as const,
  permission: 'authenticated_publish_only' as const,
  dedupe: 'utc_scheduled_minute' as const,
  exactly_once: false as const,
  gap: 'missed_platform_tick_not_backfilled' as const,
  backlog_max_age_hours: 24 as const,
  backlog_max_entries: 10000 as const,
  backlog_overflow: 'admission_reports_cron_due_capacity_exceeded' as const,
  platform_cron: PLATFORM_CRON,
};
const FIELD_BOUNDS = [
  {min: 0, max: 59, dow: false},
  {min: 0, max: 23, dow: false},
  {min: 1, max: 31, dow: false},
  {min: 1, max: 12, dow: false},
  {min: 0, max: 7, dow: true},
] as const;
const NUMBER = /^(?:0|[1-9][0-9]?)$/;
export class CronError extends Error {
  constructor() { super('invalid_cron'); this.name = 'CronError'; }
}
type Field = {values: Set<number>; star: boolean};
type ParsedCron = {minute: Field; hour: Field; dom: Field; month: Field; dow: Field};

function expand(field: string, bounds: {min: number; max: number; dow: boolean}): Field {
  if (field.length < 1 || field.length > 64) throw new CronError();
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part.length < 1) throw new CronError();
    const pieces = part.split('/');
    if (pieces.length > 2) throw new CronError();
    const base = pieces[0] ?? '';
    let step = 1;
    if (pieces.length === 2) {
      if (!/^[1-9][0-9]?$/.test(pieces[1] ?? '')) throw new CronError();
      step = Number(pieces[1]);
    }
    let start: number;
    let end: number;
    if (base === '*') {
      start = bounds.min;
      end = bounds.max;
    } else {
      const range = base.split('-');
      if ((range.length !== 1 && range.length !== 2) || range.some(item => !NUMBER.test(item))) throw new CronError();
      if (range.length === 1 && pieces.length === 2) throw new CronError();
      start = Number(range[0]);
      end = Number(range.length === 2 ? range[1] : range[0]);
    }
    if (start < bounds.min || end > bounds.max || start > end) throw new CronError();
    for (let value = start; value <= end; value += step) values.add(bounds.dow && value === 7 ? 0 : value);
  }
  if (values.size < 1) throw new CronError();
  return {values, star: field === '*'};
}
export function parseCron(expression: string): ParsedCron {
  if (expression.length < 9 || expression.length > 128) throw new CronError();
  const fields = expression.split(' ');
  if (fields.length !== 5) throw new CronError();
  const [minute, hour, dom, month, dow] = FIELD_BOUNDS.map((bounds, index) => expand(fields[index] ?? '', bounds));
  const parsed = {minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!};
  if (!occurs(parsed)) throw new CronError();
  return parsed;
}
export function assertSupportedCron(expression: string): void {
  parseCron(expression);
}
function dayMatches(parsed: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const dom = parsed.dom.values.has(dayOfMonth);
  const dow = parsed.dow.values.has(dayOfWeek);
  if (parsed.dom.star && parsed.dow.star) return true;
  if (parsed.dom.star) return dow;
  if (parsed.dow.star) return dom;
  return dom || dow;
}
function occurs(parsed: ParsedCron): boolean {
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2028, 11, 31);
  for (let time = start; time <= end; time += 86_400_000) {
    const date = new Date(time);
    if (!parsed.month.values.has(date.getUTCMonth() + 1)) continue;
    if (dayMatches(parsed, date.getUTCDate(), date.getUTCDay())) return true;
  }
  return false;
}
export function cronMatches(expression: string, utcMs: number): boolean {
  const parsed = parseCron(expression);
  const date = new Date(utcMs);
  if (!parsed.minute.values.has(date.getUTCMinutes()) || !parsed.hour.values.has(date.getUTCHours())) return false;
  if (!parsed.month.values.has(date.getUTCMonth() + 1)) return false;
  return dayMatches(parsed, date.getUTCDate(), date.getUTCDay());
}
export function scheduledMinute(utcMs: number): number {
  return Math.floor(utcMs / 60_000) * 60_000;
}
export function cronEventId(utcMs: number): string {
  const date = new Date(scheduledMinute(utcMs));
  const part = (value: number) => String(value).padStart(2, '0');
  return `cron-${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}T${part(date.getUTCHours())}${part(date.getUTCMinutes())}`;
}
export function publishedCronFacts(expression: string) {
  return {expression, ...CRON_CONTRACT};
}
