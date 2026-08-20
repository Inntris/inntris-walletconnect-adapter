#!/usr/bin/env bash
# Track A demo: recipient authority through the real WalletConnect CWP path.
#
#   Agent -> WalletConnect CLI -> CWP discovery -> wallet-inntris
#         -> Inntris /verify -> /verify-token(consume) -> downstream wallet
#
# Scenario 1 sends to an authorised recipient and the wallet runs.
# Scenario 2 changes only transaction.to and the wallet is never invoked.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${INNTRIS_DEMO_DIR:-${ROOT}/.demo}"

if [[ ! -f "${DEMO_DIR}/env.sh" ]]; then
  echo "Run scripts/demo-setup.sh first." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "${DEMO_DIR}/env.sh"

DEMO_CHAIN="${INNTRIS_DEMO_CHAIN:-eip155:8453}"
ACCOUNT="${INNTRIS_DEMO_ACCOUNT:-0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}"
APPROVED_RECIPIENT="${INNTRIS_DEMO_APPROVED_RECIPIENT:-0x1111111111111111111111111111111111111111}"
BLOCKED_RECIPIENT="${INNTRIS_DEMO_BLOCKED_RECIPIENT:-0x9999999999999999999999999999999999999999}"

WALLET_CLI="${ROOT}/node_modules/@walletconnect/cli-sdk/dist/cwp-cli.js"
if [[ ! -f "${WALLET_CLI}" ]]; then
  echo "WalletConnect CLI not installed. Run: npm install" >&2
  exit 1
fi

LOCAL_CORE_PID=""
cleanup() {
  [[ -n "${LOCAL_CORE_PID}" ]] && kill "${LOCAL_CORE_PID}" 2>/dev/null
}
trap cleanup EXIT

# Start the local Core stand-in only when INNTRIS_CORE_URL points at the
# default loopback port and nothing is already listening there.
if [[ "${INNTRIS_CORE_URL}" == "http://127.0.0.1:8787" ]] \
  && ! curl -s -o /dev/null --max-time 1 "${INNTRIS_CORE_URL}/verify"; then
  echo "==> Starting the local Inntris Core stand-in (no live credentials configured)"
  node "${ROOT}/scripts/local-core.mjs" 8787 \
    "{\"allowed_chains\":[\"${DEMO_CHAIN}\"],\"allowed_recipients\":{\"${DEMO_CHAIN}\":[\"${APPROVED_RECIPIENT}\"]}}" &
  LOCAL_CORE_PID=$!
  sleep 1
  echo
fi

rule() { printf '\n\033[1m%s\033[0m\n' "$1"; }

rule "0. CWP discovery — what WalletConnect can see on this PATH"
echo "PATH providers: $(ls "$(dirname "$(command -v wallet-inntris)")")"
node "${WALLET_CLI}" list
echo

run_scenario() {
  local title="$1" recipient="$2"
  rule "${title}"
  rm -f "${DOWNSTREAM_MARKER_FILE}"

  : > "${INNTRIS_AUDIT_LOG}"

  local input
  input="$(printf '{"account":"%s","chain":"%s","transaction":{"to":"%s","value":"0x2386f26fc10000","data":"0x"}}' \
    "${ACCOUNT}" "${DEMO_CHAIN}" "${recipient}")"
  echo "request: ${input}"
  echo

  echo "$ wallet send-transaction --wallet inntris"
  echo "${input}" | node "${WALLET_CLI}" send-transaction --wallet inntris
  local exit_code=$?
  echo
  echo "CWP exit code: ${exit_code}"

  echo
  echo "Inntris audit trail (stderr from wallet-inntris; the WalletConnect CLI"
  echo "drains provider stderr, so it is mirrored to INNTRIS_AUDIT_LOG):"
  sed 's/^/  /' "${INNTRIS_AUDIT_LOG}"
  echo

  if [[ -f "${DOWNSTREAM_MARKER_FILE}" ]]; then
    printf '\033[1;33mdownstream wallet invocations: %s\033[0m\n' \
      "$(wc -l < "${DOWNSTREAM_MARKER_FILE}" | tr -d ' ')"
  else
    printf '\033[1;32mdownstream wallet invocations: 0 — the wallet was never called\033[0m\n'
  fi
  echo
}

run_scenario "1. PASS — authorised recipient (${APPROVED_RECIPIENT})" "${APPROVED_RECIPIENT}"
run_scenario "2. BLOCK — unauthorised recipient (${BLOCKED_RECIPIENT}), only transaction.to changed" "${BLOCKED_RECIPIENT}"

rule "Summary"
cat <<'EOF'
Both runs traversed the same path: the WalletConnect CLI discovered
wallet-inntris on PATH and invoked it over CWP. In the PASS run Inntris
approved the exact request, the approval token was consumed, and only then was
the wallet spawned. In the BLOCK run Inntris denied it and the wallet process
was never created.

The [inntris] lines above are on stderr. Protocol stdout stays clean CWP JSON,
so the response remains valid for any CWP caller.
EOF
