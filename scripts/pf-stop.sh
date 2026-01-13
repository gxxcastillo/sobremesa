#!/usr/bin/env zsh
# Disable pf entirely (simple dev teardown). Adjust if you rely on pf elsewhere.
set -euo pipefail

echo "[pf] Disabling pf (requires sudo)"
sudo pfctl -d || true

echo "[pf] pf disabled. To re-enable, run scripts/pf-start.sh or 'sudo pfctl -e' and load rules."
