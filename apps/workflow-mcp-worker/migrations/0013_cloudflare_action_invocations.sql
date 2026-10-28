-- Stable send fence; never persist the message or temporary URL.
CREATE TABLE IF NOT EXISTS cloudflare_action_invocations (
 run_id TEXT NOT NULL,step_id TEXT NOT NULL,invocation_id TEXT NOT NULL UNIQUE,
 source_attempt_id TEXT NOT NULL,input_digest TEXT NOT NULL,
 binding_generation INTEGER NOT NULL,contract_digest TEXT NOT NULL,
 deployment_id TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,step_id)
);
CREATE TABLE IF NOT EXISTS cloudflare_action_cancellations (
 run_id TEXT NOT NULL,step_id TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,step_id)
);
