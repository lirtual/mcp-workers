export type PublicErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'ACCESS_DENIED'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_DISABLED'
  | 'CONNECTION_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'MULTI_STATEMENT_REJECTED'
  | 'READ_ONLY_VIOLATION'
  | 'QUERY_TIMEOUT'
  | 'RESULT_LIMIT_EXCEEDED'
  | 'WRITE_NOT_CONFIGURED'
  | 'WRITE_LIMIT_EXCEEDED'
  | 'ADMIN_NOT_CONFIGURED'
  | 'ADMIN_OPERATION_NOT_SUPPORTED'
  | 'ADMIN_CONFIRMATION_REQUIRED'
  | 'RATE_LIMITED'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

export class PublicError extends Error {
  readonly code: PublicErrorCode;

  constructor(code: PublicErrorCode, message: string) {
    super(message);
    this.name = 'PublicError';
    this.code = code;
  }
}

interface DriverErrorLike {
  code?: unknown;
  errno?: unknown;
  name?: unknown;
}

function driverCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as DriverErrorLike;
  if (typeof value.code === 'string') return value.code;
  if (typeof value.errno === 'number') return String(value.errno);
  return undefined;
}

export function mapDatabaseError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;

  const code = driverCode(error);
  const timeoutCodes = new Set(['57014', 'ER_QUERY_TIMEOUT', '3024', 'PROTOCOL_SEQUENCE_TIMEOUT']);
  const unavailableCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'PROTOCOL_CONNECTION_LOST'
  ]);
  const readOnlyCodes = new Set(['25006', 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION']);
  const deniedCodes = new Set([
    '42501',
    'ER_ACCESS_DENIED_ERROR',
    'ER_DBACCESS_DENIED_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR',
    'ER_COLUMNACCESS_DENIED_ERROR',
    'ER_PROCACCESS_DENIED_ERROR',
    'ER_SPECIFIC_ACCESS_DENIED_ERROR'
  ]);

  if (code && timeoutCodes.has(code)) return new PublicError('QUERY_TIMEOUT', 'The database query timed out.');
  if (code && unavailableCodes.has(code)) {
    return new PublicError('CONNECTION_UNAVAILABLE', 'The database connection is unavailable.');
  }
  if (code && readOnlyCodes.has(code)) {
    return new PublicError('READ_ONLY_VIOLATION', 'The read-only database path rejected the operation.');
  }
  if (code && deniedCodes.has(code)) {
    return new PublicError('ACCESS_DENIED', 'The database account is not permitted to access the requested object.');
  }
  return new PublicError('DATABASE_ERROR', 'The database rejected the request.');
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;
  return new PublicError('INTERNAL_ERROR', 'The request could not be completed.');
}
