#!/usr/bin/env bash
# Prepare the Track A demo environment.
#
# Builds the adapter, assembles a governed PATH that exposes wallet-inntris and
# nothing else, and warms the downstream info cache so the first discovery call
# in the demo does not pay for a cold downstream spawn inside WalletConnect's
# 3 s budget.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${INNTRIS_DEMO_DIR:-${ROOT}/.demo}"
BIN_DIR="${DEMO_DIR}/bin"

DEMO_CHAIN="${INNTRIS_DEMO_CHAIN:-eip155:8453}"
APPROVED_RECIPIENT="${INNTRIS_DEMO_APPROVED_RECIPIENT:-0x1111111111111111111111111111111111111111}"

echo "==> Building wallet-inntris"
cd "${ROOT}"
npm run --silent build

echo "==> Preparing ${DEMO_DIR}"
rm -rf "${DEMO_DIR}"
mkdir -p "${BIN_DIR}"

# The governed PATH exposes the shim only. The downstream wallet is reached by
# absolute path, so an agent on this PATH cannot address it directly.
ln -sf "${ROOT}/dist/cli.js" "${BIN_DIR}/wallet-inntris"

DOWNSTREAM_BIN="${INNTRIS_DOWNSTREAM_WALLET_BIN:-${ROOT}/tests/fixtures/wallet-recording-stub}"
if [[ ! -x "${DOWNSTREAM_BIN}" ]]; then
  echo "Downstream wallet binary is missing or not executable: ${DOWNSTREAM_BIN}" >&2
  exit 1
fi

cat > "${DEMO_DIR}/env.sh" <<EOF
# Sourced by demo.sh. Override any of these before running demo-setup.sh.
#
# The demo bin directory is prepended to the existing PATH rather than
# replacing it, so ordinary tools stay available. What matters for the demo is
# that the downstream wallet is NOT on this PATH — wallet-inntris refuses to
# delegate when it is, unless INNTRIS_ALLOW_DISCOVERABLE_DOWNSTREAM=true.
export PATH="${BIN_DIR}:\${PATH}"
export INNTRIS_DOWNSTREAM_WALLET_BIN="${DOWNSTREAM_BIN}"
export INNTRIS_DOWNSTREAM_PROVIDER_NAME="${INNTRIS_DOWNSTREAM_PROVIDER_NAME:-companion}"
export INNTRIS_AGENT_ID="${INNTRIS_AGENT_ID:-11111111-2222-3333-4444-555555555555}"
export INNTRIS_PRIVATE_KEY_B64="${INNTRIS_PRIVATE_KEY_B64:-$(node -e 'process.stdout.write(Buffer.alloc(32,7).toString("base64"))')}"
export INNTRIS_CORE_URL="${INNTRIS_CORE_URL:-http://127.0.0.1:8787}"
export INNTRIS_RECEIPT_BASE_URL="${INNTRIS_RECEIPT_BASE_URL:-https://inntris.com/verify}"
export INNTRIS_INFO_CACHE_PATH="${DEMO_DIR}/downstream-info.json"
export DOWNSTREAM_MARKER_FILE="${DEMO_DIR}/downstream-invocations.jsonl"
# The WalletConnect CLI drains and discards provider stderr, so the Inntris
# audit trail is mirrored to a file to stay visible through the real CLI path.
export INNTRIS_AUDIT_LOG="${DEMO_DIR}/inntris-audit.log"
EOF

# shellcheck source=/dev/null
source "${DEMO_DIR}/env.sh"

echo "==> Warming the downstream info cache"
wallet-inntris info > "${DEMO_DIR}/info.json"
cat "${DEMO_DIR}/info.json"
echo

echo "==> Configure this wallet policy on the Inntris agent"
cat <<EOF
PATCH /admin/agents/${INNTRIS_AGENT_ID:-<agent-id>}
{
  "metadata": {
    "wallet_policy": {
      "allowed_chains": ["${DEMO_CHAIN}"],
      "allowed_recipients": {
        "${DEMO_CHAIN}": ["${APPROVED_RECIPIENT}"]
      }
    }
  }
}

The agent must also have "wallet_transaction" in allowed_actions, a trust score
of at least 30, and must be production eligible: Core refuses to consume a
sandbox approval token, so a sandbox agent cannot reach the downstream wallet.
EOF

echo
echo "Setup complete. Run: scripts/demo.sh"
