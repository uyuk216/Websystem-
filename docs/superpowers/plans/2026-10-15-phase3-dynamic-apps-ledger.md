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
Task 8 (web part): implemented WITHOUT review — restart API + dynamic app UI (env vars, logs, access logs, usage, restart). Status shown is "live/not deployed" (no live container status endpoint). e2e requires APP_ENV_KEY.
Remaining: Task 8 Kubernetes driver + CI + docs; reviews of T7 fix and T8 web; Phase 3 final review.
Task 8 (k8s part): KubernetesDriver (server-side apply via @kubernetes/client-node, KubeApi seam mocked in tests), per-deployment Deployment/Service names, RUNTIME_DRIVER=docker|kubernetes, docs — commits 1346d72..49c3b90, WITHOUT review. Not run against a real cluster (no gvisor RuntimeClass, edge must run in ys-system, dev images not visible to k3d).
Note: quay.io/minio anonymous pull returned 401 on the Mac (2026-10-17); dev-up works with MINIO_IMAGE=chainguard/minio. CI still uses quay.io.
Remaining: reviews of T7 fix, T8 web, T8 k8s; Phase 3 final review; E2E upload→wake on Mac.
Review 2026-10-17 (controller, inline): T7 fix — OK except edge shutdown could hang forever on keep-alive/WebSocket (server.close never resolves) so logs never flushed → fixed (closeIdleConnections + 10s cap). T8 web — restart button allowed double restart (second stops the fresh container) → fixed. T8 k8s driver — no Critical.
Phase 3 final review: lint/typecheck/all unit+integration tests green on the user's Mac with real Docker (api 183, platform 112 incl. DockerDriver, static 31). Accepted gaps: restart of a dynamic app stops the running container before starting (same deployment id → same name), so a failed restart leaves the app down until redeploy/rollback; E2E (Playwright) not run on the Mac; Kubernetes driver never run against a real cluster; open T7 minors (chunked bytes=0, WebSocket not logged, socket IP behind proxy).
Phase 3: complete (with the gaps above).
2026-10-17 bug pass on the Mac: E2E 13/13 green. Fixed: oversized-body 413 could hang the client (edge didn't read the body + Connection: close; flaky 25MB test ~1/3) → drain body, no forced close; failed restart now stops the broken container (app sleeps, next request wakes normally); MinIO default image → chainguard/minio:latest (quay.io and Docker Hub return 401/denied) in compose and CI.
2026-10-18: flaky — dynamic-rollout 'crashing deployment' got build_failed instead of app_exited once in a full parallel run (passes alone 3/3); likely Docker build contention. Not investigated yet.
2026-10-18: flaky — deployments 'oversized archive' timed out (60s) once in a full parallel run (passes alone 3/3); likely MinIO/IO contention. Not investigated yet.
2026-10-18: 'oversized archive' flake fixed (test now caps at 1 MB via maxBytes instead of streaming 300 MB). 'crashing deployment' build_failed flake not reproduced in 2 full runs; the assertion now prints the deployment findings (build/run logs) if it recurs.
2026-10-18: Kubernetes driver exercised on the Mac's k3d tenant cluster (no gVisor, K8S_RUNTIME_CLASS=none added). Found and fixed a Critical: @kubernetes/client-node's typed serializer dropped NetworkPolicy ingress `from` (its model field is `_from`), so the isolation policy allowed all namespaces. apply now sends raw JSON server-side apply; verified default→app blocked, ys-system→app allowed, pod securityContext/resources/volumes intact. Still not done: gVisor on k3d, edge running inside the cluster, egress rules exercised.
2026-10-18 01:20 (paused by user, resume 05:00): egress verified on k3d (DNS/80/443 open; 25, 169.254.169.254, other-ns pods, kube API, host DB blocked). gVisor installed on k3d tenant via scripts/k3d-gvisor.sh (release 20261012, sha512 checked); app pod runs under runsc ("Starting gVisor"), non-root, read-only root, metadata blocked. Note: kube-router needs a few seconds after a new client pod appears before namespaceSelector admits it (long-running edge unaffected).
NEXT: (1) docs for k3d-gvisor.sh; (2) run the edge (apps/static) inside the cluster in ys-system with RUNTIME_DRIVER=kubernetes — needs an image registry the cluster can pull from (worker currently builds images only in local Docker), RBAC for the edge/worker, and an end-to-end upload→wake check; (3) full tests + E2E + review of changed code.
2026-10-18 05:00–: Phase 3 remainder done on the Mac's k3d tenant cluster:
- Registry: scripts/k3d-registry.sh (localhost:5050 mirrored into the nodes); IMAGE_REGISTRY makes the worker push built images and run from the registry ref (push failure → build_failed with log; both local tags cleaned on every non-hand-off path).
- Health: KubernetesDriver adds a tcpSocket readinessProbe and readyMeansHealthy, so waitHealthy trusts a Ready pod instead of fetching the in-cluster Service from outside. Weaker than the Docker check (5xx-only apps count as healthy) — accepted.
- Edge in cluster: dev/k8s/edge.yaml + scripts/k3d-edge.sh (ServiceAccount + ClusterRole ys-runtime, Ingress catch-all on :8081, preStop 5s). Verified: build → push → gVisor pod → response via in-cluster edge with env var; sleep → wake in ~3s; 50 concurrent requests to a sleeping app start it once (all 200); access logs and runtime minutes recorded.
- Bugs found and fixed: (1) edge restarts returned 502 (no drain) → preStop + keep idle keep-alive sockets until timeout (2 rounds 120/120 OK during restart); (2) CoreDNS host.k3d.internal lost after node restarts → k3d-edge.sh re-adds it; (3) access-log/X-Forwarded-For used the socket address behind the ingress → EDGE_TRUSTED_PROXY_HOPS (default 0); (4) pushImage registry check allowed ".." path segments → fixed with a test.
- Accepted/known: in k3d the L4 load balancer hides the Mac's IP (production must preserve source at the LB, phase 8); registry has no GC of old images; worker/API still run outside the cluster (in-cluster BuildKit is phase 8).
- Checks: lint, typecheck, all unit/integration tests (platform 117, api 184, static 34, …) and E2E 17/17 green.
Phase 3: complete.
2026-10-18: fixed open T7 minors — streamed (no Content-Length) responses now log the bytes actually sent; WebSocket tunnels are logged as 101 with relayed bytes on close. Found while testing: a client closing a WebSocket left the tunnel half-open if the app did not close, keeping the app awake (keep-alive touch) indefinitely → the edge now ends both sides when either side ends. Remaining T7 minor: path segments may contain tokens (query strings are already dropped).
