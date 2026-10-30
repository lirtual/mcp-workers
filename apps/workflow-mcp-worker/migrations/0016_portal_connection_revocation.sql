-- One fixed, reviewed Portal Connection. Revocation is independent of immutable Plans.
-- Generation 0 grants continuity to previously published read-only MCP Plans.
CREATE TABLE portal_connection_auth (
 id TEXT PRIMARY KEY CHECK(id='portal'),
 state TEXT NOT NULL CHECK(state IN ('enabled','revoked')),
 generation INTEGER NOT NULL CHECK(generation>=0),
 updated_at INTEGER NOT NULL
);
INSERT INTO portal_connection_auth (id,state,generation,updated_at)
 VALUES ('portal','enabled',0,0);
-- The unique Run/Step record is the irrevocable external-call reservation.
-- Revocation races this INSERT under D1 serialization, not a stale read.
CREATE TABLE mcp_dispatch_fences (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL,
 generation INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,step_id), FOREIGN KEY(run_id) REFERENCES runs(id)
);
