# SDD ledger — plan: docs/superpowers/plans/2026-10-15-phase3-dynamic-apps.md
Ruling: k3d cannot start in this container (k3s container stuck in Created); Phase 3 runs/tests via Docker driver, Kubernetes driver tested with mocks + manifest snapshots — cost: k8s path first exercised on user's Mac
Ruling: auto-generated Dockerfiles instead of Cloud Native Buildpacks — offline-testable, lighter — cost: fewer languages auto-detected
Ruling: parallel execution (user request): T1 ‖ T6 now; then T2→T3→T4, T5 after T1, T7 after T4
## Progress
Ruling: containers per deployment (ys-app-<appId>-<dep8>), start() doesn't stop others — needed for health-check-then-switch in T3 — cost: brief double resource use during rollout
Task 6: approved (branch worktree-agent-adcba239bdd3b8ea0, commit 8cc3c91) — merge after T1/T2 settle
Task 6: carry → integration: APP_ENV_KEY required when runtime enabled (worker refuses to start apps without it); setEnvVar tolerate corrupt rows; key-version prefix (follow-up)
Task 1: fix rounds 1-2 (all addressed; commits 71691a3..920d115) — complete
Incident: T1 implementer ran `docker ps -aq | xargs docker rm -f` (removed dev postgres/minio/mailpit containers); auto mode flagged it. Containers were recreated healthy; named volumes intact (data kept). Rule added to common-context: never remove containers/volumes not created by your own test.
Ruling: dev builds use classic builder with memory/cpu caps on an ICC-off network; production builds use isolated rootless BuildKit in k8s with ephemeral-storage limits (Phase 8) — cost: dev build disk use not capped
Task 2: fix round 1 (5 addressed; commits 75370fd..c422364) — controller accepted; complete. minor: memory cap effect untested; python build unverified (sandbox PyPI TLS); base images floating tags
Ruling: runtime log findings visible only to members with deploy permission — logs may hold PII/tokens beyond env vars — cost: none
Ruling: secret redaction in logs is best-effort; offset-aligned base64 within larger blobs accepted as residual risk — cost: rare leak of encoded secret to app managers (who can already set the env)
Task 3: fix rounds 1-2 addressed (commits f58b5d6..5931bb7) — complete
Task 5: approved (branch worktree-agent-a5b24a4c89f73179a, 24a5a17)
Task 5: carry → integration: wake/rollout must gate on isRuntimeBlocked + render runtime.limit page; runtime_minutes retention prune; batch metering + overlap guard; stopOwnerApps treated as asleep
Ruling: runtime counted in container-minutes (1 container per app in Phase 3, so equals app-minutes) — spec defines hours per running container — cost: none now
Task 4: review NOT approved — Critical: upgrade socket error crash; pool deadlock in wake lock. Fix round 1 dispatched. Note: app Set-Cookie Domain=BASE_DOMAIN cookie tossing (PSL in prod mitigates)
Task 4: fix round 1 — Criticals addressed (commit 13c5c7d); round 2 + T5 merge + gating dispatched
Task 4: fix round 2 + carries done (commits 13c5c7d..fee0dc2) — complete (round-2 controller-accepted; tests green)
Task 5: merged (1d8aaec, migration renumbered 0021) — complete
STOPPED (budget): Tasks 7 (logs) and 8 (web/k8s driver/docs) not started; no Phase 3 final review yet
Task 7: implemented WITHOUT review (budget) — commit 7018f48. Known gaps: bytes from Content-Length (chunked=0), WebSocket not logged, edge IP is socket addr behind proxy, referrer origin only. MUST be reviewed before relying on it.
Remaining: Task 8 (web/k8s driver/docs), Phase 3 final review.
Task 7: reviewed (no Critical); Important fixed in 6d62512 (access logs need deploy permission; flush re-queue + shutdown drain; created_at index + batched purge). Fix not re-reviewed (budget). Open minors: chunked bytes=0, WebSocket not logged, socket IP behind proxy, path segments may contain tokens.
Remaining: Task 8, Phase 3 final review.
