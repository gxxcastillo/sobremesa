#!/usr/bin/env zsh
# Forward 443 -> 4443 on lo0 for sobremesa.x
set -euo pipefail

RULES_FILE="$(pwd)/tmp/pf-sobremesa.conf"
mkdir -p "$(pwd)/tmp"

cat > "$RULES_FILE" <<'EOF'
rdr pass on lo0 inet proto tcp from any to any port 443 -> 127.0.0.1 port 4443
EOF

echo "[pf] Loading rules from $RULES_FILE (requires sudo)"
sudo pfctl -f "$RULES_FILE"
sudo pfctl -e || true

echo "[pf] Active rdr rules:"
sudo pfctl -sr | grep rdr || true

echo "[pf] 443 is now forwarded to 4443 on localhost."
