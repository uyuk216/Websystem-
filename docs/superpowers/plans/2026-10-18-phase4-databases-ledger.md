# SDD ledger — plan: docs/superpowers/plans/2026-10-18-phase4-databases.md
Ruling: Docker driver = one postgres:16-alpine container per app on an internal per-app network (app container joins it); backups are hourly pg_dump to MinIO, restore = rebuild from a dump. True point-in-time restore only in the Kubernetes driver (CloudNativePG) — cost: dev restore granularity is 1 hour.
Ruling: DATABASE_URL from the platform overrides a user env var of the same name when a DB exists.
## Progress
