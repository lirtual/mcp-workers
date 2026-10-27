CREATE TABLE IF NOT EXISTS weixin_binding (
  id INTEGER PRIMARY KEY CHECK (id=1),
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('unbound','qr_pending','bound_unverified','ready','needs_interaction','reauth_required','temporarily_unavailable')),
  session_ciphertext TEXT,
  session_key_id TEXT,
  last_verified_context_at INTEGER,
  last_sync_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK((session_ciphertext IS NULL)=(session_key_id IS NULL))
);
INSERT OR IGNORE INTO weixin_binding(id,generation,state,updated_at) VALUES(1,0,'unbound',0);
CREATE TABLE IF NOT EXISTS weixin_send_receipts (
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  text_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unknown','accepted','rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(generation,request_id)
);
CREATE INDEX IF NOT EXISTS idx_weixin_receipts ON weixin_send_receipts(generation,created_at);
-- No automatic receipt expiry: forgotten IDs must not silently replay.
