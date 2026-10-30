-- Independent HTTP authorization generation. HTTP operations use the
-- existing unique mcp_dispatch_fences Run/Step reservation; no new queue.
CREATE TABLE http_connection_auth (
 id TEXT PRIMARY KEY CHECK(id='http'),
 state TEXT NOT NULL CHECK(state IN ('enabled','revoked')),
 generation INTEGER NOT NULL CHECK(generation>=0),
 updated_at INTEGER NOT NULL
);
INSERT INTO http_connection_auth(id,state,generation,updated_at)
 VALUES('http','enabled',0,0);
