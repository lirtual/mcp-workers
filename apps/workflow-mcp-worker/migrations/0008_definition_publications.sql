-- T04: immutable staging evidence; no active workflow pointer or runtime mutation.
CREATE TABLE IF NOT EXISTS definition_publications (
  publication_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL REFERENCES workflow_definition_versions(definition_digest),
  source_sha TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  publisher_run_id TEXT NOT NULL,
  publisher_run_attempt INTEGER NOT NULL CHECK(publisher_run_attempt > 0),
  publisher_workflow_sha TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(repository_id, publisher_run_id, publisher_run_attempt, workflow_id, source_sha)
);
CREATE INDEX IF NOT EXISTS idx_definition_publications_digest
  ON definition_publications(definition_digest);
