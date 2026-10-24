# Phase 6 integration contracts

Everything in this directory is inert: nothing downloads, installs, provisions or applies it.
`doctor.sh` reports missing integrations; passing fake tests does not prove production defenses.

Falco is a Linux-node sensor, not a macOS process. A production adapter must obtain current container ID,
pod UID, namespace and deployment from the runtime control plane, and use an atomic shared replay store.
Approve pinned engine, rules, driver and collector versions/permissions before enabling the private listener.
Host and gVisor syscall visibility, latency, drops and unknown rules need separate live measurement.

Metrics are cumulative per-app counters. Missing windows, stale data, resets and mixed identities are unknown.
CPU alone only notifies. Falco's independent mining/escape rules may stop an app. Approved event boosts change
only the served-byte surge threshold; CPU, egress, phishing and traps retain their thresholds.

The optional egress policy REPLACES broad internet rules with scoped DNS and the explicit proxy. It is not
applied by this work. A proxy must deny metadata, private ranges, other tenants, platform destinations and
SMTP, validate resolved destinations at connect time and prevent rebinding/CONNECT bypass. Arbitrary TCP,
UDP/QUIC and IPv6 tunnels are unsupported/denied; setting HTTP_PROXY is insufficient. Tenant DB and health
exceptions require explicit scoped policy review. Never inspect or retain TLS bodies or full URLs.

Publication uses an injected SafeBrowsingClient. Without it, new publication/rollback is held and an existing
healthy version keeps serving. Only canonical tenant origins are sent; no query, upload URL or credentials.
An unlisted URL is not a safety certificate. Approve provider terms, disclosure and credentials separately.

Distribution evidence uses a separate durable transaction, not access-log buffers. The edge observer counts
bytes pulled toward the client, including partial responses and bytes before cancellation, and counts no
body for HEAD/304. This is not proof of remote receipt. Transfer billing retains its own single meter.
HTML decoration decodes supported gzip/br/deflate streams and removes invalid length/digest/ETag headers;
HEAD, 304, partial 206 and non-HTML responses advertise the report page through Link without rewriting ranges.
Unknown content encodings fail closed. CSP remains intact and no tenant JS is trusted. Reports retain only
a fixed category, not free text, credentials or referrers, and never block an app based on a report alone.
