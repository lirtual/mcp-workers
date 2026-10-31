-- Cross-provider migration admission. Included inside the same D1 INSERT
-- that grants a new external send; this is NOT a separate preflight read.
CREATE TABLE IF NOT EXISTS cloudflare_action_gate(
 id INTEGER PRIMARY KEY CHECK(id=1),
 state TEXT NOT NULL CHECK(state IN ('open','frozen')),
 changed_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO cloudflare_action_gate(id,state,changed_at) VALUES(1,'open',0);
