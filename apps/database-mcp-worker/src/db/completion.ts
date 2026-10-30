import { mapDatabaseError, PublicError } from '../errors.js';

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
