import { describe, expect, it } from 'vitest';
import { mapDatabaseError } from '../../src/errors.js';

describe('Direct TLS error boundary', () => {
  it('maps certificate and host identity failures to a stable redacted code', () => {
    for (const code of [
      'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
    ]) {
      const error = mapDatabaseError({ code, message: 'postgres://user:secret@db.example.com/app' });
      expect(error.code).toBe('TLS_VERIFICATION_FAILED');
      expect(error.message).not.toMatch(/secret|postgres:\/\//);
    }
  });
});
