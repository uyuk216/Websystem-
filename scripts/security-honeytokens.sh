#!/usr/bin/env bash
set -euo pipefail
echo 'NOT INSTALLED: honeytokens are not deployed. No values are generated or written by this script.'
echo 'Approval required: deploy-time generation of the 7 placements (values stay out of Git/logs), PostgreSQL audit extension (e.g. pgAudit) + log collector pinned version/image/audit scope, Falco rule for decoy file reads (reuses the Task 3 approval).'
echo 'Limits: no real-cloud key is created, so use against real cloud cannot be observed; env theft and offline reads of backups are not detected.'
