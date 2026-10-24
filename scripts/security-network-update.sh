#!/usr/bin/env bash
set -euo pipefail
echo 'NOT INSTALLED: network reputation data source disabled. Nothing is downloaded.'
echo 'Approval required: IP anonymity product (MaxMind/IPinfo contract, terms, update cadence), Tor exit list, school CIDR / iCloud Private Relay / Cloudflare trusted bot lists (source, pinned version, license).'
echo 'Until then SECURITY_NETWORK_MODE defaults to observe and the API reports state=not_installed; enforce returns 503 on protected actions only.'
