# inntris-walletconnect-adapter

`wallet-inntris` — an Inntris CWP provider that places Inntris Core in the
execution path of a WalletConnect CLI wallet operation.

```
Agent → WalletConnect CLI SDK / CWP → wallet-inntris → Inntris Core
                                                        ├─ BLOCK → wallet never runs
                                                        └─ PASS → consume token → wallet
```

It is a pre-execution authority adapter, not a WalletConnect fork and not an
application-level optional callback. No WalletConnect code is modified or
copied; the wire contract is implemented independently.

## Install

```bash
npm install
npm run build          # produces dist/cli.js with a Node shebang
```

Expose it to WalletConnect by putting `wallet-inntris` on the PATH the CLI
sees, and keep the real wallet off that PATH:

```bash
ln -s "$PWD/dist/cli.js" /path/to/governed-bin/wallet-inntris
export PATH="/path/to/governed-bin:$PATH"
```

## Configure

Copy `.env.example` and fill it in. The essentials:

```bash
INNTRIS_CORE_URL=https://api.inntris.com
INNTRIS_AGENT_ID=<agent uuid>
INNTRIS_PRIVATE_KEY_B64=<base64 32-byte Ed25519 seed>
INNTRIS_DOWNSTREAM_WALLET_BIN=/absolute/path/to/wallet-companion
INNTRIS_DOWNSTREAM_PROVIDER_NAME=companion
```

The agent needs `wallet_transaction` (and/or `wallet_signature`) in
`allowed_actions`, a trust score of at least 30, and must be production
eligible — Core refuses to consume a sandbox approval token, so a sandbox agent
can never reach the downstream wallet.

Chain and recipient authority is per-agent policy in Core:

```json
{
  "wallet_policy": {
    "allowed_chains": ["eip155:8453"],
    "allowed_recipients": {
      "eip155:8453": ["0x1111111111111111111111111111111111111111"]
    }
  }
}
```

Set it with `PATCH /admin/agents/{agent_id}`, which merges metadata rather than
replacing it, so production approval and sandbox state survive.

## Operations

Pass-through, delegated directly without consulting Inntris:
`accounts`, `balance`, `history`, `get-session`.

Inntris-gated, authorised and consumed before the wallet runs:
`sign-message`, `sign-typed-data`, `sign-transaction`, `send-transaction`,
`grant-session`, `revoke-session`, `generate`, `fund`, `drain`, `swidge`.

Anything else exits `2` / `UNSUPPORTED_OPERATION`. An unknown mutating
operation is never passed through silently.

## Exit codes

| Situation                                                   | Exit             | `code`                  |
| ----------------------------------------------------------- | ---------------- | ----------------------- |
| Success                                                     | 0                | —                       |
| Inntris policy BLOCK                                        | 3                | `USER_REJECTED`         |
| Inntris Core timeout, or budget exhausted before delegation | 4                | `TIMEOUT`               |
| Core unavailable, malformed response, integrity failure     | 1                | `INTERNAL_ERROR`        |
| Unknown operation                                           | 2                | `UNSUPPORTED_OPERATION` |
| Downstream failure                                          | relayed verbatim | relayed                 |

`USER_REJECTED` for a policy block is semantically imperfect. It is the closest
code the current protocol defines — there is no `POLICY_DENIED`, and inventing
one would make the response unintelligible to existing CWP callers.

Protocol stdout stays clean CWP JSON. Inntris diagnostics go to stderr, and to
`INNTRIS_AUDIT_LOG` if set — the WalletConnect CLI drains provider stderr and
discards it, so the file sink is how the receipt URLs survive that path.

## Demo

```bash
scripts/demo-setup.sh    # build, assemble the governed PATH, warm the info cache
scripts/demo.sh          # PASS then BLOCK, through the real WalletConnect CLI
```

See `docs/DEMO.md`.

## Tests

```bash
npm test              # unit + integration
npm run typecheck
npm run lint
npm run build
npm run check         # all of the above plus formatting
```

The integration suite runs the published `@walletconnect/cli-sdk` binaries
against a temporary PATH, so the discovery, capability filtering, and exit-code
mapping it exercises are WalletConnect's own.

## Documentation

- `docs/ARCHITECTURE.md` — module map, execution sequence, latency budgeting,
  the Phase 0 assumptions table
- `docs/DEMO.md` — the recipient-authority demo, step by step
- `SECURITY.md` — the invariants and how each is enforced
- `THREAT_MODEL.md` — what this does and does not defend against
