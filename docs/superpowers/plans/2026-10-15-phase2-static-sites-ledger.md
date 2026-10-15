# SDD ledger — plan: docs/superpowers/plans/2026-10-15-phase2-static-sites.md
Spec: docs/superpowers/specs/2026-10-15-platform-design.md
## Pre-flight scan
| Pair | Produces → Consumes | Finding |
|---|---|---|
| T1→T4,T5,T6,T8 | apps/deployments schema | ok |
| T2→T4,T5,T6 | storage/queue | ok |
| T3→T4 | inspectArchive/scanSecrets | ok |
| T5 transfer_usage ↔ T1 schema | T5 adds table | ok |
| T7 Bearer ↔ T4 routes | requireSession accepts Bearer | ok |
| each task self-consistent | | ok |
Ruling: Phase 2 enforces 1 static site per owner without plan/Student check (plans are Phase 5) — spec phases — cost: any account can host 1 site in dev
Ruling: no build step for static sites in Phase 2 (publishDir only) — BuildKit is Phase 3 — cost: users must upload built output
## Progress
Task 1: complete (commits dd3b08c..4d01989, review clean)
Task 1: minor (deferred): publishDir error code 'format' on create; dot dirs allowed in publishDir (T4 must apply exclusions after resolving); apps/deployments write policy FOR ALL for any member (owner_id could be changed via SQL); concurrency test single-connection
Task 1: carry → T4: wire enqueueStorageCleanup into DELETE /apps/:id; enforce deploy permission on deployment writes
Ruling: shared storage/queue live in packages/platform (not apps/api) — worker needs to import them — cost: none
Task 2: fix round 1/5 (3 addressed; commits ce9342c..c2ea8e8) — controller spot-checked diff
Task 2: complete (commits 4d01989..c2ea8e8, review clean)
Task 2: minor (deferred): worker exit code on stop failure; unchecked casts in get
Task 3: fix round 1/5 (4 addressed; commits 19cc918..37f5f86)
Task 3: complete (commits c2ea8e8..37f5f86, review clean)
Task 3: minor (deferred): no explicit test for extract return() cleanup; >2MB files skip secret scan
Ruling: deployment may go live only if createdAt > apps.liveSince (set on every switch/rollback) — prevents older queued deploy overriding a rollback — cost: an upload started just before a rollback is not published (user re-deploys)
Ruling: accept rolled_back_at (rollback-only) instead of liveSince-on-every-switch — newer-createdAt rule already orders normal switches — cost: none
Task 4: fix round 1/5 (4 addressed; commits cb0a852..84f2280)
Task 4: complete (commits 37f5f86..84f2280, review clean)
Task 4: minor (deferred): existing pg-boss queue keeps old retry options (use updateQueue in deploy); zip with single wrapping folder not unwrapped; no chunked-over-limit HTTP test
Ruling: user asked for parallel speed — T6 and T7 run in isolated worktrees concurrently with T5, merged sequentially by controller; migrations renumbered at merge — cost: merge conflicts in app.ts/schema/i18n
Task 5: minor (deferred): isBlocked cache unbounded; If-None-Match *; ETag not content hash; /foo serves index without redirect; cross-package test import
Task 5: fix round 1/5 (4 addressed; commits 93d4348..3b5c282) — controller verified migration 0012 + tests reported
Task 5: complete (commits 84f2280..3b5c282, review clean)
Ruling: GitHub installation must be bound to account via user OAuth (/user/installations) before PATCH /apps/:id/github — otherwise cross-account private repo hijack — cost: extra OAuth setup (client id/secret)
Ruling: destructive team/app/member routes are cookie-only (Bearer tokens for CI cannot delete/transfer) — limits blast radius of leaked CLI token — cost: CLI cannot delete apps
Task 7: fix round 1/5 (3 addressed; commits f3041e3..bee6d0d)
Task 7: Ruling: Bearer tokens may deploy/rollback/create apps (CLI purpose); per-IP 429 also blocking valid tokens after 30 failures and fail-open when failed-map full are accepted — 256-bit tokens make guessing infeasible; limiter only protects DB load — cost: NAT users may be locked out 10 min by a misconfigured client
Task 7: complete (commits 84f2280..bee6d0d, 1 parked)
Task 6: fix round 1/5 (5 addressed incl. Critical installation binding; commits dfde011..3f4b6c8)
Task 6: open → integration: release delivery claim on failure; commit-sha dedupe not atomic (dup deployment only)
Task 8: approved; open → integration: upload 413/network handling, double-submit, installationId input guard, saved-state per form
Integration: T6 + T8 merged, fixes applied, Task 9 done (commits bee6d0d..16503a7); all tests + 12 e2e pass
Task 6: complete; Task 8: complete; Task 9: complete
Open: rollback to superseded deployment with same commit as queued/live row → unique index 500
Final review: no Critical; 3 Important fixed (rollback 500, stuck queued sweep, Bearer privilege routes) — commit 2241e3d; re-review all ADDRESSED
Ruling: sweep does not release github delivery claim (no delivery id on deployment) — new pushes still work; same-delivery redelivery ignored ≤7 days — cost: rare missed redelivery
Final minor (deferred): abort not covering connect phase; finish() may overwrite superseded with failed (cosmetic); superseded site files never pruned; FOR ALL write policy on apps
