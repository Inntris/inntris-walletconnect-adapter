# Track A demo — recipient authority

Two runs of the same transaction through the real WalletConnect CWP path,
differing only in `transaction.to`. One reaches the wallet; the other never
creates the wallet process.

## Run it

```bash
npm install
scripts/demo-setup.sh
scripts/demo.sh
```

`demo-setup.sh` builds the adapter, assembles a governed PATH exposing
`wallet-inntris` and nothing else, warms the downstream info cache, and prints
the wallet policy to configure. `demo.sh` runs both scenarios.

With no `INNTRIS_CORE_URL` configured, the demo starts a local Inntris Core
stand-in (`scripts/local-core.mjs`) so it runs without credentials. It
implements the verified `/verify` and `/verify-token` contract and recomputes
the action hash for real, but it does not verify signatures, keep an audit
chain, or anchor receipts — the audit ids it prints are placeholders. Point
`INNTRIS_CORE_URL` at a real Core for real ones.

## Agent prerequisites

For a live Core, the demo agent needs:

- `wallet_transaction` in `allowed_actions`
- trust score ≥ 30
- **production eligible** — Core refuses `consume=true` for a sandbox approval
  token, so a sandbox agent can never reach the wallet. This is intentional and
  must not be worked around to make a demo easier.
- this wallet policy:

```json
{
  "metadata": {
    "wallet_policy": {
      "allowed_chains": ["eip155:8453"],
      "allowed_recipients": {
        "eip155:8453": ["0x1111111111111111111111111111111111111111"]
      }
    }
  }
}
```

Set via `PATCH /admin/agents/{agent_id}`, which merges metadata rather than
replacing it.

## Step 0 — discovery

```
$ wallet list
{
  "providers": [
    {
      "name": "inntris",
      "binary": "wallet-inntris",
      "rdns": "com.inntris.wallet",
      "capabilities": ["accounts", "balance", "sign-message",
                       "sign-typed-data", "sign-transaction", "send-transaction"],
      "chains": ["eip155:8453", "eip155:1"]
    }
  ]
}
```

One provider. The real wallet is not on this PATH; `wallet-inntris` reaches it
by absolute path.

## Scenario 1 — PASS

```
$ echo '{"account":"0xAAAA…","chain":"eip155:8453",
         "transaction":{"to":"0x1111…","value":"0x2386f26fc10000","data":"0x"}}' \
  | wallet send-transaction --wallet inntris

{
  "transactionHash": "0xDOWNSTREAMTXHASH"
}

CWP exit code: 0

[inntris] PASS decision=<decision-audit-id> consumption=<consumption-audit-id>
[inntris] verify=https://inntris.com/verify/<decision-audit-id>
[inntris] consumption=https://inntris.com/verify/<consumption-audit-id>
[inntris] delegating to companion (178790ms budget)
[inntris] downstream stderr: DOWNSTREAM WALLET INVOKED

downstream wallet invocations: 1
```

## Scenario 2 — BLOCK

Only `transaction.to` changes.

```
$ echo '{"account":"0xAAAA…","chain":"eip155:8453",
         "transaction":{"to":"0x9999…","value":"0x2386f26fc10000","data":"0x"}}' \
  | wallet send-transaction --wallet inntris

Blocked by Inntris policy: recipient is not authorised

CWP exit code: 3

[inntris] BLOCK audit=<decision-audit-id> violation=wallet_recipient_not_allowed
[inntris] verify=https://inntris.com/verify/<decision-audit-id>
[inntris] downstream wallet was NOT invoked

downstream wallet invocations: 0 — the wallet was never called
```

The downstream stub appends to `DOWNSTREAM_MARKER_FILE` on every invocation. In
the BLOCK run the file does not exist at all, so the count is evidence rather
than a log line that could have been suppressed.

## Where the output goes

`[inntris]` lines are stderr. The WalletConnect CLI drains provider stderr and
discards it, so the demo mirrors them to `INNTRIS_AUDIT_LOG` and prints the
file. Protocol stdout carries only the downstream CWP JSON — no Inntris
extension fields — so the response stays valid for any CWP caller.

## Receipts

Against a live Core, the printed URLs resolve to public verification pages. A
freshly created receipt may report `pending_anchor`; that is expected, and
nothing here claims an on-chain anchor exists until Core reports one.
