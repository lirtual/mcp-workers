import { PublicError } from '../errors.js';
import type { Dialect, DatabaseTransport } from '../types.js';

export interface NormalizedConnectionInput {
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function invalid(): never {
  // Do not reflect credentials, submitted URLs or upstream parser messages.
  throw new PublicError('INVALID_INPUT', 'Invalid database connection input.');
}
function field(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length > 1) invalid();
  return values[0] ?? '';
}
function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return invalid(); }
}
/** One normalization seam for the URL/Fields selector; never forward URL options to a driver. */
export function normalizeConnectionInput(
  form: URLSearchParams, dialect: Dialect, transport: DatabaseTransport
): NormalizedConnectionInput {
  if (!['mysql', 'postgres'].includes(dialect) || !['direct', 'hyperdrive'].includes(transport)) invalid();
  const mode = field(form, 'input_mode');
  if (mode !== 'url' && mode !== 'fields') invalid();
  const providedUrl = field(form, 'url');
  const hostField = field(form, 'host');
  const portField = field(form, 'port');
  const databaseField = field(form, 'database');
  const usernameField = field(form, 'username');
  const passwordField = field(form, 'password');
  let source: URL;
  if (mode === 'url') {
    if (!providedUrl || providedUrl.length > 8192 ||
      [hostField,portField,databaseField,usernameField,passwordField].some(Boolean)) invalid();
    try { source = new URL(providedUrl); } catch { return invalid(); }
  } else {
    if (providedUrl || !hostField || !databaseField || !usernameField || !passwordField ||
      /[^a-zA-Z0-9.:[\]-]/.test(hostField)) invalid();
    const port = portField || (dialect === 'mysql' ? '3306' : '5432');
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) invalid();
    try {
      source = new URL(`${dialect === 'postgres' ? 'postgresql' : 'mysql'}://${hostField}:${port}/`);
      source.username = usernameField;
      source.password = passwordField;
      source.pathname = '/' + encodeURIComponent(databaseField);
    } catch { return invalid(); }
  }
  if (!(dialect === 'mysql' ? source.protocol === 'mysql:' :
    source.protocol === 'postgres:' || source.protocol === 'postgresql:') ||
    !source.hostname || !source.username || !source.pathname.startsWith('/') ||
    !source.pathname.slice(1) || source.hash) invalid();
  const params = [...source.searchParams];
  if (params.length > 1 || (params.length === 1 && params[0]![0] !== 'sslmode')) invalid();
  if (params.length) {
    const option = params[0]![1].toLowerCase();
    if (transport === 'direct' ? option !== 'disable' :
      !['require','verify-ca','verify-full'].includes(option)) invalid();
  }
  const user = decoded(source.username);
  const password = decoded(source.password);
  const database = decoded(source.pathname.slice(1));
  const port = source.port ? Number(source.port) : (dialect === 'mysql' ? 3306 : 5432);
  if (!user || !password || !database || port < 1 || port > 65535) invalid();
  // Canonical URL uses the explicit default port and drops every driver parameter.
  const normalized = new URL(`${dialect === 'postgres' ? 'postgresql' : 'mysql'}://${source.host}/`);
  normalized.port = String(port);
  normalized.username = user;
  normalized.password = password;
  normalized.pathname = '/' + encodeURIComponent(database);
  return {url: normalized.toString(), host: source.hostname, port, database, user, password};
}
