# SDD ledger — plan: docs/superpowers/plans/2026-10-15-phase1-foundation.md
Spec: docs/superpowers/specs/2026-10-15-platform-design.md

## Pre-flight scan
| Pair / Task | Produces → Consumes | Finding |
|---|---|---|
| T5 ↔ T7 | T7 generateRecoveryCode/hashRecoveryCode → T5 registerAccount | T5 needs T7 first |
| T7 ↔ T4 | T4 sessions → T7 approveRecovery revokes sessions | ok if T4 before T7 |
| T3 ↔ T9 | T3 schema → T9 adds team_invites | T9 extends schema, ok |
| T10 ↔ T4-9 | withAccount retrofits services | ok, T10 modifies earlier code |
| T6 ↔ T5 | email_challenges cols crossDevice* from T3 | ok |
| T8 ↔ T5-7 | recordLogin called at login success | ok, T8 modifies |
| T11 ↔ T5-9 | HTTP routes | ok |
| each task self-consistency | tests vs signatures | ok |

Ruling: execution order 1,2,3,4,7,5,6,8,9,10,11,12 — T5 calls T7's recovery-code functions — cost if wrong: none, only order.
Ruling: env has no k3d; Task 1 verifies with --no-k8s only, k3d configs written but unverified here — cost: k3d config bug found later on Mac.
Ruling: Docker daemon started manually in this container (dockerd); compose used for Postgres/Mailpit — cost: none.

## Progress
Task 1: complete (commits b2c7642..d472bc3, review clean)
Task 1: minor (deferred): .env.development copied but not sourced by anything yet
Task 1: minor (deferred): quay.io minio default unverified here (env override MINIO_IMAGE=chainguard/minio used in this container)
Task 1: minor (deferred): vitest.workspace.ts possibly unused with pnpm -r test
Task 2: complete (commits d472bc3..4585dab, review clean)
Task 2: minor (deferred): age uses UTC today (JST up to 9h late, safe side); Feb29 non-leap untested
Task 3: minor (deferred): base64 key parsing lenient; no FK/lookup indexes; drizzle.config dev URL fallback
Task 3: fix round 1/5 (4 addressed, 0 open; commits a1a024d..95cf7e2)
Task 3: complete (commits 4585dab..95cf7e2, review clean)
Task 3: minor (deferred): CHECK reject tests use bare toThrow without message match
Ruling: rateLimit takes key function instead of string key — needed per-request keys (IP/email) — cost: none
Ruling: mailer is createMailer(smtpUrl) factory, not free sendMail reading env — DI for tests — cost: none
Task 4: minor (deferred): lastSeenAt write per request; expired sessions never purged; cookie Secure on http dev; rateLimit keys must not use spoofable headers (Task 5)
Task 4: fix round 1/5 (2 addressed, 1 new open — full-map sweep ungated; commits 4fb3b75..9ad880c)
Task 4: fix round 2/5 (1 addressed, 0 open; commits 9ad880c..7b1520a)
Task 4: complete (commits 95cf7e2..7b1520a, review clean)
Task 4: minor (deferred): redundant nextSweep guard after line-19 sweep
Ruling: remove katakana ク ケ シ ツ ソ from recovery alphabet — user asked confusables removed; brief list incomplete — cost: slightly smaller alphabet (still >80 bits)
Task 7: minor (deferred): per-email limiter allows victim lockout of recovery (5/h); recovery_attempts no cleanup; rate_limited vs invalid distinguishable (same for unknown)
Task 7: fix round 1/5 (5 addressed, 2 new open — hops undocumented, getConnInfo untested; commits 61537f8..ff7ab7e)
Task 7: fix round 2/5 (4 addressed, 1 new open — decrypt after commit regression; commits ff7ab7e..efd1799)
Task 7: fix round 3/5 (1 addressed, 0 open; commits efd1799..d22ea88)
Task 7: complete (commits 7b1520a..d22ea88, review clean)
Ruling: email link redemption is Task 6's openEmailLink; Task 5 keeps the link in the mail — plan splits it that way — cost: link dead until Task 6 lands
Task 5: minor (deferred): signup burns challenge on email mismatch; no concurrency test for double-verify; no signup HTTP cookie test
Task 5: fix round 1/5 (3 addressed, 2 open — sync throw escapes, indentation; commits bf3b081..3c4c3c8)
Ruling: login mail failure logged only (200 returned) — avoids account-existence leak; Phase 2 job queue retries — cost: user may wait for a code that never arrives
Task 5: fix round 2/5 (2 addressed, 0 open; commits 3c4c3c8..393f775) — Ruling: 15-line fix diff re-reviewed by controller directly instead of a subagent — cost saving; risk: less independent eyes on a trivial change
Task 5: complete (commits d22ea88..393f775, review clean)
Ruling: scanToken stored plaintext (stable per challenge, cleared on approve/fail, ≤10 min) instead of hash+rotate — rotation broke polling QR; token alone can't log in without number match — cost: DB reader could see live scan tokens for ≤10 min
Ruling: email link redemption is POST (page JS) not GET — mail scanner prefetch would burn one-time links — cost: link needs JS-enabled page
Task 6: minor (deferred): confirm endpoints need only scanToken (no session) — by design; region always null until GeoIP
Task 6: fix round 1/5 (3 addressed, 1 new — web page /login/link not yet POSTing; commits 6e3fc0c..17583f9)
Task 6: Ruling: /login/link page POSTing to /auth/email/link is Task 11's deliverable (carried into Task 11 dispatch) — cost: email link flow unusable until Task 11
Task 6: minor (deferred): UUID regex duplicated in 3 files
Task 6: complete (commits 393f775..17583f9, review clean after ruling)
Task 8: minor (deferred): no passkey cap per account; migration 0004 device_key NOT NULL without default (pre-release ok)
Task 8: fix round 1/5 (3 addressed in code; test gaps: expired-challenge purge branch, history-failure only on passkey path; commits 7fb0f49..3ee51b0)
Task 8: Ruling: remaining items are test-coverage gaps with correct code — deferred as minors, not load-bearing — cost: regression in expired-purge branch could go unnoticed
Task 8: complete (commits 17583f9..3ee51b0, 1 parked)
Task 9: complete (commits 3ee51b0..8e6a369, review clean)
Task 9: minor (deferred): invite to existing member/self wastes seat; re-invite deletes old invite before cap check (lost on 'full'); invite limit per IP not per account; invite rows never purged; deleteTeam owners row vs future FKs
Ruling: Task 10 pre-auth flows use withSystem (owner role, API process) instead of SECURITY DEFINER functions — same trust boundary, far less SQL — cost: a bug in a withSystem call site bypasses RLS
Ruling: API switches to platform_api via SET LOCAL ROLE per transaction instead of a second DB login — no extra credential in dev — cost: must ensure every authenticated query runs inside withAccount
Task 10: minor (deferred): acceptInvite whole tx as system; teams authed_insert allows orphan teams; member_rows FOR ALL lets any member mutate rows at DB level (app layer enforces roles); nested withAccount leaves role set
Task 10: fix round 1/5 (3 addressed, 0 open; commits 0bf2363..736c13c) — Ruling: controller verified fix directly (db:generate clean, startup check wired) instead of re-review subagent — cost: less independent review of small fix
Task 10: complete (commits 8e6a369..736c13c, review clean)
Ruling: web uses Next.js rewrites /api/* → API for same-origin cookies — avoids CORS + cross-site cookie issues — cost: prod needs same routing at edge
Ruling: Task 11 adds GET /me/sessions, DELETE /me/sessions/:id, POST /auth/logout to API — devices page needs them; Task 4 had no HTTP routes — cost: none
Task 11: complete (commits 736c13c..f8b3543, review clean)
Task 11: minor (deferred): e2e lacks requester device assertion & wrong-number check is weak; English signup/recover untested; app layout infinite loading on non-401 error; invite params lost on login bounce; tsconfig.tsbuildinfo committed; team page has no self id; passkey UI untested
Task 12: fix round 1 requested — audit 9 findings (vitest/tinypool critical, postcss high)
Task 12: fix round 1/5 (audit fixed; commits ac891c5..a27ea21); review: overrides unbounded, gitleaks PR permission
Task 12: minor (deferred): deps still ^ ranges (renovate pins on first PR); service images not digest-pinned
Task 12: fix round 2/5 (2 addressed, 0 open; commits a27ea21..50e4c39) — controller verified diff + audit directly
Task 12: complete (commits f8b3543..50e4c39, review clean)
Final review: NOT READY — C1 QR confirm not bound to link-opening device (account takeover); I1 single IP behind Next proxy; I2 RLS missing on accounts/pre-auth tables; I3 no absolute session expiry
Final fix wave dispatched (C1, I1, I2, I3, layout error state, re-invite cap order)
Ruling: accounts RLS allows read of teammates' rows (app_shares_team) — needed for team member display names; email_enc is encrypted — cost: teammates' encrypted email/recovery hash readable by a buggy authed query
Final fix wave: re-review all ADDRESSED, no new Critical/Important (commits 50e4c39..2a321db)
