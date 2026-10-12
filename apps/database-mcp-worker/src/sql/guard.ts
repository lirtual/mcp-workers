import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';

const READ_START: Record<Dialect, ReadonlySet<string>> = {
  postgres: new Set(['SELECT', 'WITH', 'VALUES']),
  mysql: new Set(['SELECT', 'WITH'])
};

const FORBIDDEN_KEYWORDS = new Set([
  'INSERT','UPDATE','DELETE','MERGE','REPLACE','CREATE','ALTER','DROP','TRUNCATE','GRANT','REVOKE','CALL','DO','COPY','VACUUM','ANALYZE','SET','RESET','SHOW','USE','LOCK','UNLOCK','PREPARE','EXECUTE','DEALLOCATE','HANDLER','OPTIMIZE','REPAIR','LOAD','OUTFILE','DUMPFILE','INTO'
]);
const FORBIDDEN_MYSQL_FUNCTIONS = new Set(['GET_LOCK','RELEASE_LOCK','RELEASE_ALL_LOCKS','SLEEP','BENCHMARK']);
const FORBIDDEN_POSTGRES_FUNCTIONS = new Set(['PG_ADVISORY_LOCK','PG_ADVISORY_LOCK_SHARED','PG_TRY_ADVISORY_LOCK','PG_TRY_ADVISORY_LOCK_SHARED','PG_ADVISORY_UNLOCK','PG_ADVISORY_UNLOCK_SHARED','PG_ADVISORY_UNLOCK_ALL','PG_ADVISORY_XACT_LOCK','PG_ADVISORY_XACT_LOCK_SHARED','PG_TRY_ADVISORY_XACT_LOCK','PG_TRY_ADVISORY_XACT_LOCK_SHARED','NEXTVAL','SETVAL','SET_CONFIG','PG_SLEEP','PG_SLEEP_FOR','PG_SLEEP_UNTIL','PG_CANCEL_BACKEND','PG_TERMINATE_BACKEND']);
const FORBIDDEN_LOCK_SEQUENCES: ReadonlyArray<readonly string[]> = [['FOR','UPDATE'],['FOR','SHARE'],['FOR','NO','KEY','UPDATE'],['FOR','KEY','SHARE'],['LOCK','IN','SHARE','MODE']];

interface ScanResult { sql: string; words: string[]; statementTerminators: number[]; }
function isWordStart(char: string): boolean { return /[A-Za-z_]/.test(char); }
function isWordPart(char: string): boolean { return /[A-Za-z0-9_$]/.test(char); }
function isTagChar(char: string): boolean { return /[A-Za-z0-9_]/.test(char); }

function scan(sql: string): ScanResult {
  const words: string[] = [];
  const statementTerminators: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '-' && next === '-') { i += 2; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; continue; }
    if (char === '#') { i += 1; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; continue; }
    if (char === '/' && next === '*') {
      if (sql[i + 2] === '!' || sql[i + 2] === '+' || (sql[i + 2]?.toUpperCase() === 'M' && sql[i + 3] === '!')) throw new PublicError('READ_ONLY_VIOLATION','Executable or optimizer block comments are not allowed in user SQL.');
      i += 2; let closed = false;
      while (i < sql.length - 1) { if (sql[i] === '*' && sql[i + 1] === '/') { i += 2; closed = true; break; } i += 1; }
      if (!closed) throw new PublicError('INVALID_INPUT','SQL contains an unterminated block comment.');
      continue;
    }
    if (char === "'") {
      i += 1; let closed = false;
      while (i < sql.length) { if (sql[i] === '\\') { i += 2; continue; } if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i += 1; closed = true; break; } i += 1; }
      if (!closed) throw new PublicError('INVALID_INPUT','SQL contains an unterminated string literal.');
      continue;
    }
    if (char === '"' || char === '`') {
      const quote = char; i += 1; let closed = false;
      while (i < sql.length) { if (sql[i] === quote) { if (sql[i + 1] === quote) { i += 2; continue; } i += 1; closed = true; break; } i += 1; }
      if (!closed) throw new PublicError('INVALID_INPUT','SQL contains an unterminated quoted identifier.');
      continue;
    }
    if (char === '$') {
      let tagEnd = i + 1; while (tagEnd < sql.length && isTagChar(sql[tagEnd]!)) tagEnd += 1;
      if (sql[tagEnd] === '$') { const tag = sql.slice(i, tagEnd + 1); const closeAt = sql.indexOf(tag, tagEnd + 1); if (closeAt === -1) throw new PublicError('INVALID_INPUT','SQL contains an unterminated dollar-quoted string.'); i = closeAt + tag.length; continue; }
    }
    if (char === ';') { statementTerminators.push(i); i += 1; continue; }
    if (isWordStart(char)) { const start = i; i += 1; while (i < sql.length && isWordPart(sql[i]!)) i += 1; words.push(sql.slice(start, i).toUpperCase()); continue; }
    i += 1;
  }
  return { sql, words, statementTerminators };
}

function stripTrailingTerminator(sql: string, scanResult: ScanResult): string {
  if (scanResult.statementTerminators.length === 0) return sql.trim();
  if (scanResult.statementTerminators.length > 1) throw new PublicError('MULTI_STATEMENT_REJECTED','Only one SQL statement is allowed per invocation.');
  const terminator = scanResult.statementTerminators[0]!;
  const after = sql.slice(terminator + 1);
  const trailing = scan(after);
  if (trailing.words.length > 0 || trailing.statementTerminators.length > 0) throw new PublicError('MULTI_STATEMENT_REJECTED','Only one SQL statement is allowed per invocation.');
  const normalizedTail = after.replace(/--[^\r\n]*/g,'').replace(/#[^\r\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'').trim();
  if (normalizedTail.length > 0) throw new PublicError('MULTI_STATEMENT_REJECTED','Only one SQL statement is allowed per invocation.');
  return sql.slice(0, terminator).trim();
}

function containsSequence(words: string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > words.length) return false;
  for (let i = 0; i <= words.length - sequence.length; i += 1) {
    let matched = true;
    for (let j = 0; j < sequence.length; j += 1) if (words[i + j] !== sequence[j]) { matched = false; break; }
    if (matched) return true;
  }
  return false;
}

export interface GuardedSql { sql: string; firstKeyword: string; }
export function guardReadQuery(sql: string, dialect: Dialect): GuardedSql {
  if (typeof sql !== 'string' || sql.trim().length === 0) throw new PublicError('INVALID_INPUT','SQL must be a non-empty string.');
  if (sql.length > 100_000) throw new PublicError('INVALID_INPUT','SQL exceeds the maximum supported length.');
  const scanned = scan(sql);
  const normalized = stripTrailingTerminator(sql, scanned);
  const rescanned = normalized === sql ? scanned : scan(normalized);
  const firstKeyword = rescanned.words[0];
  if (!firstKeyword || !READ_START[dialect].has(firstKeyword)) throw new PublicError('READ_ONLY_VIOLATION','query_read accepts only read queries.');
  for (const keyword of rescanned.words) if (FORBIDDEN_KEYWORDS.has(keyword)) throw new PublicError('READ_ONLY_VIOLATION',`Read query contains forbidden operation '${keyword}'.`);
  for (const sequence of FORBIDDEN_LOCK_SEQUENCES) if (containsSequence(rescanned.words, sequence)) throw new PublicError('READ_ONLY_VIOLATION','Locking reads are not allowed.');
  const forbiddenFunctions = dialect === 'mysql' ? FORBIDDEN_MYSQL_FUNCTIONS : FORBIDDEN_POSTGRES_FUNCTIONS;
  for (const word of rescanned.words) if (forbiddenFunctions.has(word)) throw new PublicError('READ_ONLY_VIOLATION',`${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} function '${word}' is not allowed.`);
  return { sql: normalized, firstKeyword };
}

export function injectMySqlExecutionTimeout(sql: string, timeoutMs: number): string {
  const timeout = Math.max(1, Math.min(Math.trunc(timeoutMs), 60_000));
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!; const next = sql[i + 1];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '-' && next === '-') { i += 2; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; continue; }
    if (char === '#') { i += 1; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; continue; }
    if (char === '/' && next === '*') { if (sql[i + 2] === '!' || sql[i + 2] === '+' || (sql[i + 2]?.toUpperCase() === 'M' && sql[i + 3] === '!')) throw new PublicError('READ_ONLY_VIOLATION','Executable or optimizer block comments are not allowed in user SQL.'); const closeAt = sql.indexOf('*/', i + 2); if (closeAt === -1) throw new PublicError('INVALID_INPUT','SQL contains an unterminated block comment.'); i = closeAt + 2; continue; }
    if (char === "'" || char === '"' || char === '`') { const quote = char; i += 1; while (i < sql.length) { if (sql[i] === '\\') { i += 2; continue; } if (sql[i] === quote) { if (sql[i + 1] === quote) { i += 2; continue; } i += 1; break; } i += 1; } continue; }
    if (isWordStart(char)) { const start = i; i += 1; while (i < sql.length && isWordPart(sql[i]!)) i += 1; const word = sql.slice(start, i).toUpperCase(); if (word === 'SELECT') return `${sql.slice(0, i)} /*+ MAX_EXECUTION_TIME(${timeout}) */${sql.slice(i)}`; continue; }
    i += 1;
  }
  return sql;
}

export function toReadLimitedSql(sql: string, _dialect: Dialect, rowLimit: number): string {
  const limit = Math.max(1, Math.trunc(rowLimit));
  return `SELECT * FROM (${sql}) AS __mcp_query LIMIT ${limit}`;
}

export function sanitizedSqlPreview(sql: string, maxLength = 500): string {
  let result = ''; let i = 0;
  while (i < sql.length && result.length < maxLength) {
    const char = sql[i]!; const next = sql[i + 1];
    if (char === '-' && next === '-') { i += 2; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; result += ' '; continue; }
    if (char === '#') { i += 1; while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1; result += ' '; continue; }
    if (char === '/' && next === '*') { const closeAt = sql.indexOf('*/', i + 2); i = closeAt === -1 ? sql.length : closeAt + 2; result += ' '; continue; }
    if (char === "'") { i += 1; while (i < sql.length) { if (sql[i] === '\\') { i += 2; continue; } if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i += 1; break; } i += 1; } result += "'?'"; continue; }
    if (char === '$') { let tagEnd = i + 1; while (tagEnd < sql.length && isTagChar(sql[tagEnd]!)) tagEnd += 1; if (sql[tagEnd] === '$') { const tag = sql.slice(i, tagEnd + 1); const closeAt = sql.indexOf(tag, tagEnd + 1); if (closeAt === -1) { result += '$?$'; break; } i = closeAt + tag.length; result += '$?$'; continue; } }
    if (/[0-9]/.test(char)) { while (i < sql.length && /[0-9A-Fa-fxXbBeE+_.-]/.test(sql[i]!)) i += 1; result += '?'; continue; }
    if (/\s/.test(char)) { if (!result.endsWith(' ')) result += ' '; i += 1; continue; }
    result += char; i += 1;
  }
  return result.trim().slice(0, maxLength);
}
