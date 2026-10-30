import { mapDatabaseError, PublicError } from '../errors.js';

/** A rejected connection attempt occurs before this Worker has sent SQL.
 * Never use this marker for a query error, timeout after SQL dispatch, or lost receipt. */
export class ConfirmedNoSqlFailure extends PublicError {
  readonly publicError: PublicError;
  constructor(cause: unknown) {
    const safe = mapDatabaseError(cause);
    super(safe.code, safe.message);
    this.name = 'ConfirmedNoSqlFailure';
    this.publicError = safe;
  }
}

/** Internal evidence only: a database read failed, and the same pinned
 * session subsequently acknowledged ROLLBACK. Never construct this for
 * timeout, connection loss, a failed rollback, or an unconfirmed write. */
export class ConfirmedReadFailure extends PublicError {
  readonly publicError: PublicError;
  constructor(cause: unknown) {
    const safe = mapDatabaseError(cause);
    super(safe.code, safe.message);
    this.name = 'ConfirmedReadFailure';
    this.publicError = safe;
  }
}
