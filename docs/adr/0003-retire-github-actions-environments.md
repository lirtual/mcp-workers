# ADR-0003: Repository-scoped GitHub Actions configuration

**Decision:** Use repository-level GitHub Actions Variables and Secrets for the maintained Workers and associated release jobs, without separate GitHub Environments. Source code, deployment manifests and protected release checks remain the authority for required names and their selected-Worker scope; do not duplicate full configuration inventories across documents.

**Accepted trade-off:** Repository Secrets have a broader availability surface, and removing Environment reviewer gates is not equivalent to having branch protection. Manually triggered Owner/main release and preflight checks still apply but cannot prevent an identity with repository write authority from changing Workflow source. Reassess this decision if the set of writers or deployment triggers expands.

Secret values cannot be read back from GitHub API. An uncertain Secret migration, credential change or production configuration write must stop for independent confirmation; do not assume identical names mean identical bytes. Migration and accepted historical evidence remain in Git and the project Issues. This ADR does not authorize settings changes or production deployment.
