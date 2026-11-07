-- Spec #774: legacy UU Session credentials are no longer produced or read.
-- This migration is destructive. It is not authorized by source merge.
-- The reviewed Release Worker must first prove an empty source table, no
-- active/Unknown UU writers, fenced historical Plans, exact active version,
-- AND pass the existing strict (all-workflow) Migration safety gate.
-- Never modify applied 0010_session_runtime_data.sql or historical receipts.
DROP TABLE session_runtime_data;
