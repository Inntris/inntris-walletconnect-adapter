# Security

The invariants this adapter is built to hold, and where each is enforced and
tested.

## Invariants

| #   | Invariant                                                         | Enforced by                                                 | Tested by                                                                       |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | A BLOCK can never invoke the downstream wallet                    | `authoriseAndDelegate` returns before `delegate`            | `gating.test.ts`, every gated operation                                         |
| 2   | Core failure can never invoke the downstream wallet               | client throws; only a 403/429 is a decision                 | `gating.test.ts` — unavailable, timeout, malformed, non-JSON, unexpected status |
| 3   | Token-consumption failure can never invoke the wallet             | strict acceptance check in `client.ts`                      | `gating.test.ts` — eight rejection shapes                                       |
| 4   | The action committed to Inntris is the action delegated           | `payload_hash` over the complete input                      | `action-binding.test.ts`                                                        |
| 5   | No mutation between authorisation and delegation                  | raw bytes forwarded verbatim; pre-spawn recheck             | `integrity.test.ts`                                                             |
| 6   | The approval token is consumed before execution                   | fixed call order                                            | `ordering.test.ts` event log                                                    |
| 7   | Approval tokens cannot be reused                                  | Core single-use; the adapter never retries a consumed token | Core `insert_token_consumption`; integration stub                               |
| 8   | stdout stays CWP-compatible                                       | downstream JSON relayed verbatim; diagnostics on stderr     | `passthrough.test.ts`                                                           |
| 9   | Inntris secrets never reach the wallet process                    | whole `INNTRIS_` namespace stripped                         | `delegation.test.ts`, integration                                               |
| 10  | No WalletConnect fork or modification                             | protocol implemented independently in `src/cwp/`            | —                                                                               |
| 11  | Existing `financial_transaction` behaviour is unchanged           | wallet checks scoped to `wallet_*` action types             | MTP `test_wallet_policy.py::TestExistingBehaviourUnchanged`                     |
| 12  | Wallet policy cannot destroy unrelated agent metadata             | reuses the existing JSONB merge                             | MTP `PATCH /admin/agents` merge path                                            |
| 13  | Rail and trust-boundary identifiers are inside the signed payload | `buildWalletAction`                                         | `action-binding.test.ts`, integration                                           |
| 14  | Insufficient time budget fails closed                             | `Deadline.reserve` throws exit 4                            | `gating.test.ts`, `core-timeout.test.ts`                                        |
| 15  | `info` never depends on Core availability                         | `info` reads no Core config and makes no Core call          | `info.test.ts`                                                                  |
| 16  | Advertised capabilities ⊆ `SUPPORTED_CWP_OPERATIONS`              | one shared constant; intersection on all three paths        | `info.test.ts`                                                                  |
| 17  | The adapter maintains no spend ledger                             | reservation and consumption stay in Core                    | by construction                                                                 |

## How the ordering is guaranteed

`authoriseAndDelegate` in `src/cli.ts` is the only path to a wallet spawn for a
gated operation. It signs, calls `/verify`, calls `/verify-token` with
`consume: true`, rechecks integrity, and only then spawns. Every `return` and
every `throw` before the final `delegate` call leaves the wallet unspawned, and
the tests assert this through a recorded spawn list rather than through a mock's
call count on the delegate function itself.

`/verify-token` is never called after execution.

## Request integrity

The original stdin bytes are retained and forwarded to the wallet verbatim. The
parsed object is never re-serialised for delegation, so there is no second
representation of the request whose relationship to the authorised hash is an
assumption.

Immediately before the spawn, two independent recomputations must both match the
hash Inntris authorised:

- re-parsing the retained buffer, which catches a swapped buffer reference that
  hashing the same object twice could not detect;
- hashing the live parsed object, which catches in-place mutation.

Either mismatch is exit `1` / `INTERNAL_ERROR` — an internal integrity failure,
never the exit `3` that means a policy said no.

## Key handling

The Ed25519 seed is read from `INNTRIS_PRIVATE_KEY_B64`, validated as 32 bytes
at startup, and used only to sign the hex-decoded action hash. The seed buffer
and the derived secret key are zeroed in `finally` blocks before signing
returns, and neither is retained on any returned object.

The entire `INNTRIS_` environment namespace is removed from the child
environment before the wallet is spawned — not just the key, so a future
secret-valued setting is excluded by default rather than by remembering to add
it to a list.

## Evidence

Inntris Core is the sole evidence authority. The adapter issues no receipts of
its own and contains no local verdict signer. What it produces is:

- the decision audit id from `/verify`,
- the consumption audit id from `/verify-token`,
- formatted URLs at `/verify/{audit_id}`.

A PASS receipt proves Inntris authorised that exact action. The consumption
receipt proves the execution gate consumed that authorisation before delegating.
Neither proves blockchain settlement, and the adapter does not claim otherwise.

If the wallet fails after consumption, the failure is propagated, the consumed
token is not reused, and the event is logged as a failure _after_ authorisation
consumption.

## Reporting

Report suspected vulnerabilities to the Inntris security contact rather than in
a public issue.
