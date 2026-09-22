-- T04: immutable stage provenance; no active-definition pointer or runtime change.
CREATE TABLE IF NOT EXISTS definition_publications (
  publication_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL REFERENCES workflow_definition_versions(definition_digest),
  source_sha TEXT NOT NULL,
  source_path TEXT NOT NULL,
  publisher_repository_id TEXT NOT NULL,
  publisher_run_id TEXT NOT NULL,
  publisher_run_attempt INTEGER NOT NULL CHECK(publisher_run_attempt > 0),
  publisher_workflow_sha TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  state TEXT NOT NULL CHECK(state = 'staged'),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_definition_publications_digest
  ON definition_publications(definition_digest, created_at);
