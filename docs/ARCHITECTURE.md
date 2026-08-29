# Architecture

`wallet-inntris` is a CWP provider that puts Inntris Core in the execution path
of a WalletConnect CLI wallet operation. It is a pre-execution authority
adapter: it authorises, consumes the authorisation, and only then delegates to
the real wallet.

```
Agent
  ↓
WalletConnect CLI SDK / CWP
  ↓
wallet-inntris
  ↓
Inntris Core
  ├─ BLOCK → downstream wallet is never invoked
  └─ PASS
       ↓
     consume exact-action approval token
       ↓
     downstream CWP wallet
       ↓
     sign / execute
```

No WalletConnect code is forked, modified, or copied. The wire contract is
implemented independently in `src/cwp/`.

## Module map

| Path                           | Responsibility                                                        |
| ------------------------------ | --------------------------------------------------------------------- |
| `src/cli.ts`                   | Routing, the gated sequence, protocol exit handling                   |
| `src/config.ts`                | Env loading and validation, split so `info` never reads Core settings |
| `src/cwp/operations.ts`        | `SUPPORTED_CWP_OPERATIONS`, caller ceilings                           |
| `src/cwp/protocol.ts`          | Exit/error codes, `ProtocolError`, `Deadline`                         |
| `src/cwp/input.ts`             | Raw-byte retention, parse-once, JCS hashing, integrity recheck        |
| `src/inntris/action.ts`        | CWP request → Inntris payload                                         |
| `src/inntris/signing.ts`       | JCS canonicalisation, `sig_version` 3, Ed25519                        |
| `src/inntris/client.ts`        | `/verify` → `/verify-token`, strict acceptance                        |
| `src/inntris/schemas.ts`       | Zod schemas for every Core response                                   |
| `src/downstream/delegate.ts`   | Spawn, env scrubbing, PATH bypass check                               |
| `src/downstream/info-cache.ts` | `info` resolution, cache, static fallback                             |
| `src/policy/mapping.ts`        | Operation → action type, `resource_id`, risk flags                    |
| `src/policy/wallet-policy.ts`  | Wallet-policy contract, violation → message                           |
| `src/observability/logger.ts`  | stderr diagnostics, optional file mirror                              |

## The gated sequence

`authoriseAndDelegate` in `src/cli.ts` is the whole security-critical path, and
it is exported so tests drive the real function rather than a reconstruction:

1. Retain the raw stdin bytes; parse once.
2. One `crypto.randomUUID()` yields `request_ref = wc:<uuid>:verify` and
   `execution_ref = wc:<uuid>:exec`.
3. Build the Inntris payload, committing the complete CWP input through
   `payload_hash = SHA-256(JCS(input))`.
4. Sign once. The nonce is derived from `request_ref`, so an internal retry
   presents an identical signed request.
5. `POST /verify`. A 403/429 is a decision → exit 3. Anything else unexpected
   is an authority failure → exit 1 or 4.
6. `POST /verify-token` with `consume: true` and the same signed inputs.
7. Pre-spawn integrity recheck.
8. Spawn the downstream wallet with the retained bytes.

Every `return` and `throw` before step 8 leaves the wallet unspawned.

## Latency budgeting

There is no universal total budget. The caller's ceiling differs by two orders
of magnitude across operations, and a fixed cap would manufacture failures on
`send-transaction` that the protocol does not have.

```
invocation_deadline = min(CALLER_CEILING_MS[op] - 1000, INNTRIS_MAX_INVOCATION_MS?)
```

A single monotonic `Deadline` is carried through the invocation and checked
before `/verify`, before `/verify-token`, and before the spawn. Per-call
timeouts stay bounded regardless: Core keeps its fixed `INNTRIS_CORE_TIMEOUT_MS`
even on a 179-second deadline, and only the downstream slice expands.

`INNTRIS_CORE_TIMEOUT_MS` defaults to 10000 ms. It is sized against observed
production latency — Core `/verify` has answered correctly in ~3.7 s under load
— rather than against the caller's ceiling, which is 180 s for
`send-transaction`. Each Core call is capped at
`min(deadline_remaining, INNTRIS_CORE_TIMEOUT_MS)`, so on the operations that
inherit the 10 s default ceiling the deadline, not this cap, is the binding
constraint.

Insufficient remaining time fails closed with exit 4, and so does a Core call
that exceeds its cap: a wider cap changes how long the adapter waits for a
decision, never what it accepts as one.

## `info` and the discovery budget

`info` runs inside a 3-second budget while spawning a second Node process from
inside the first, so it is built to degrade rather than fail — a provider whose
`info` call fails is recorded with `info: null` by discovery and is effectively
invisible.

- Never calls Inntris Core, and never reads Core configuration.
- Cache at `~/.config/inntris/downstream-info.json`, mode `0600`, keyed on the
  downstream binary path, its mtime, **and the adapter version**. The version is
  in the key because `SUPPORTED_CWP_OPERATIONS` changes between releases.
- Cache miss → downstream `info` with a hard 1500 ms cap.
- Failure → configured static fallback.
- The capability intersection is applied on all three paths.
- `chains` pass through unmodified: chain restriction is per-agent policy
  evaluated at Core, and narrowing the list here would leak policy configuration
  into a discovery response and go stale the moment policy changes.

## Action classification

| CWP operation                                                     | Inntris action type                 |
| ----------------------------------------------------------------- | ----------------------------------- |
| `send-transaction`, `sign-transaction`, `fund`, `drain`, `swidge` | `wallet_transaction`                |
| `sign-message`, `sign-typed-data`                                 | `wallet_signature`                  |
| `grant-session`, `revoke-session`, `generate`                     | `admin_action`                      |
| `accounts`, `balance`, `history`, `get-session`                   | pass-through, Inntris not consulted |

A generic CWP transaction is **not** classified as `financial_transaction`.
Core's `financial_transaction` semantics are USD-denominated and require a
numeric spend amount; a CWP transaction may express native-token or atomic-unit
value that cannot be interpreted as USD without an authoritative
asset-normalisation layer. The signed payload deliberately carries no key named
`amount`, `amount_usd`, `value`, or `total`, because those are exactly the field
names Core's `_extract_amount` scans.

`resource_id` is emitted deterministically: `<chain>:<account>` when both are
present, `<chain>:*` with a chain but no account, `wallet:<account>` with an
account but no chain (the `sign-message` shape), and `wallet:*` with neither.

## Operation reachability

The 14 operations in `SUPPORTED_CWP_OPERATIONS` are the union of what
`companion-wallet` handles, but only six actually reach a provider through the
SDK's own routing at the pinned commit. The rest are reachable only by invoking
a provider binary directly.

| Operation                                                                                                     | Reached through SDK routing | Where                                               |
| ------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------- |
| `info`                                                                                                        | yes                         | `discovery.ts` (3 s)                                |
| `accounts`                                                                                                    | yes                         | `cwp-cli.ts`, `pay-cli`, `staking-cli`, x402 sample |
| `sign-message`                                                                                                | yes                         | `cwp-cli.ts`, `pay-cli` fallback                    |
| `sign-typed-data`                                                                                             | yes                         | `cwp-cli.ts`, x402 sample                           |
| `sign-transaction`                                                                                            | yes                         | `cwp-cli.ts`                                        |
| `send-transaction`                                                                                            | yes                         | `cwp-cli.ts`, `staking-cli`                         |
| `balance`, `history`, `get-session`, `grant-session`, `revoke-session`, `generate`, `fund`, `drain`, `swidge` | no                          | direct invocation only                              |

All 14 are implemented regardless. The demo and the integration test use
`send-transaction`, which is genuinely reachable — `cwp-cli.ts` routes it and
checks `provider.info.capabilities.includes(operation)` before spawning, which
is why the capability intersection in §10 is load-bearing rather than cosmetic.

## Phase 0 assumptions

Verified before implementation. Evidence cites the pinned WalletConnect commit
`1e80df8` and `KingsmanRon/MTP` at `master` (`8426d8b`).

| #   | Assumption                                                                                  | Verified | Evidence                                                                                                                 | Consequence                                                                 |
| --- | ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Providers are `wallet-*` executables found on `$PATH`; first match wins                     | true     | `packages/cli-sdk/src/cwp/discovery.ts:38-72`                                                                            | bin name `wallet-inntris`                                                   |
| 2   | Operation is `argv[2]`; JSON on stdin; JSON on stdout                                       | true     | `cwp/exec.ts:57-59,116-120`; `companion-wallet/src/cli.ts:544`                                                           | as specified                                                                |
| 3   | Exit codes 0–5 as documented                                                                | true     | `cwp/exec.ts:4-11`                                                                                                       | as specified                                                                |
| 4   | No `POLICY_DENIED` error code exists                                                        | true     | `cwp/exec.ts:14-21`                                                                                                      | BLOCK uses `USER_REJECTED` / exit 3                                         |
| 5   | Error JSON is `{error, code}`                                                               | true     | `cwp/exec.ts:96-103`; `companion-wallet/src/types.ts`                                                                    | as specified                                                                |
| 6   | `info` discovery budget is 3 s, parallel across providers                                   | true     | `discovery.ts:106-112`                                                                                                   | info cache + 1500 ms downstream cap                                         |
| 7   | `cwp-cli.ts` timeout table is 10/120/120/120/180 s                                          | true     | `cwp-cli.ts:138-144`                                                                                                     | `CALLER_CEILING_MS`                                                         |
| 8   | `walletExec` default is 10 s                                                                | true     | `cwp/exec.ts:50`                                                                                                         | `DEFAULT_CALLER_CEILING_MS`                                                 |
| 9   | The CWP operation union is the 15 types listed                                              | true     | `companion-wallet/src/types.ts:16-31`                                                                                    | `SUPPORTED_CWP_OPERATIONS` = 14 (excludes `info`)                           |
| 10  | Only 5 operations route through the `wallet` CLI                                            | true     | `cwp-cli.ts:6-12,236-239`                                                                                                | demo uses `send-transaction`                                                |
| 11  | `cwp-cli.ts` checks `capabilities.includes(operation)` before spawning                      | true     | `cwp-cli.ts:126-131`                                                                                                     | the capability intersection is load-bearing                                 |
| 12  | `sig_version=3` = JCS payload hash + JCS envelope, signed over `bytes.fromhex(action_hash)` | true     | `api/crypto.py:217-227,236-243`                                                                                          | signing ported exactly; asserted against Core-generated vectors             |
| 13  | `canonicalize_timestamp` emits ISO UTC with `Z`, 0 or 6 fractional digits                   | true     | `api/crypto.py:96-160`                                                                                                   | `canonicalCoreTimestamp`                                                    |
| 14  | `/verify` claims `request_ref` idempotency _before_ the nonce replay check                  | true     | `api/main.py:1893` (`claim_verify_request`) vs `1930-1948` (nonce)                                                       | retries reuse nonce, timestamp, and signature                               |
| 15  | Verification and token idempotency live in separate structures                              | true     | `verify_request_idempotency` at `api/database.py:1100-1143`; `approval_token_consumptions` at `api/database.py:992-1060` | the `:verify`/`:exec` convention is for legibility, not collision avoidance |
| 16  | Core serialises spend reservation per agent and consumes it with the token                  | true     | `api/main.py:2113-2137`; `reserve_rate_and_spend`                                                                        | the adapter keeps no spend ledger                                           |
| 17  | Production promotion merges metadata by JSONB concatenation                                 | true     | `api/database.py:503`                                                                                                    | wallet policy reuses the same merge                                         |
| 18  | `PATCH /admin/agents/{id}` already shallow-merges metadata and guards lifecycle keys        | true     | `api/main.py:3459-3466`, `3410-3423`                                                                                     | no new endpoint and no migration needed                                     |
| 19  | `AgentRecord.metadata` is a free-form dict                                                  | true     | `api/models.py:691`                                                                                                      | `wallet_policy` lives under it                                              |
| 20  | `/verify-token` refuses `consume=true` for a sandbox token                                  | true     | `api/main.py:2716-2726`                                                                                                  | the demo agent must be production eligible                                  |
| 21  | `action_type` must be alphanumeric plus underscores, and is lowercased                      | true     | `api/models.py:154-160`                                                                                                  | `wallet_transaction` / `wallet_signature` are valid                         |
| 22  | `payload.request_ref` must equal the top-level `request_ref`                                | true     | `api/models.py:162-172`                                                                                                  | included in the signed payload                                              |
| 23  | `_extract_amount` scans `amount`, `amount_usd`, `value`, `total`                            | true     | `api/policy.py` `AMOUNT_FIELDS`                                                                                          | the wallet payload carries none of them at top level                        |
| 24  | JCS vectors exist as a cross-language contract                                              | true     | `tests/fixtures/canonicalization/jcs_vectors.json`                                                                       | copied into the adapter's fixtures; all 12 pass                             |

### Assumptions that came back false or incomplete

| #   | Assumption                                                                                                | Finding                                                                                                                                                                                                                    | What changed                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | "WalletConnect drains stderr, so this preserves protocol compatibility **while making the demo visible**" | Half true. `walletExec` drains stderr specifically to avoid blocking on a full pipe, and **discards** it (`cwp/exec.ts:71-73`). The `[inntris]` lines are visible on a direct invocation but not through the `wallet` CLI. | stderr stays the primary sink — moving diagnostics to stdout would break protocol compatibility. An optional `INNTRIS_AUDIT_LOG` mirrors the same lines to a file, and the demo prints it. |
| B   | The caller-side ceilings are the `cwp-cli.ts` table                                                       | Incomplete. Two SDK samples use tighter budgets than the table: the x402 sample calls `accounts` with 5 s (`samples/x402-browser-proxy/src/index.ts:92`) and `sign-typed-data` with 30 s (`cwp-signer.ts:61`).             | The table is implemented as specified; `INNTRIS_MAX_INVOCATION_MS` exists for operators running under a tighter caller. Documented rather than guessed at.                                 |
| C   | Exit codes are 0–5                                                                                        | `companion-wallet` also defines `6 = SESSION_ERROR` (`types.ts:9`), which `cli-sdk`'s `ExitCode` does not.                                                                                                                 | The adapter never _emits_ 6, but relays a downstream exit code verbatim rather than clamping it to the 0–5 range, so a session error reaches the caller intact.                            |
| D   | `resource_id` is `<chain>:<account>` when an account is present                                           | The rule is silent on an account with no chain, which is the real `sign-message` shape.                                                                                                                                    | Emits `wallet:<account>` there — deterministic, and neither omits the field nor invents a chain.                                                                                           |

None of these hit a stop condition, so each was worked around rather than
escalated.

## What this is not

Placing Inntris in the configured provider path does not create an OS security
boundary. The correct claim is that **Inntris is non-optional within the
configured governed CWP execution path** — see `THREAT_MODEL.md`.
