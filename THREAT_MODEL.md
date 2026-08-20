# Threat model

## The claim

**Inntris is non-optional within the configured governed CWP execution path.**

That is the accurate claim, and it is narrower than "unbypassable". Within a
PATH that exposes `wallet-inntris` and not the real wallet, an agent using CWP
cannot reach the wallet without an Inntris approval that was issued for the
exact request and consumed before execution. Outside that path, this adapter has
no say at all.

## What it defends against

**A compromised or misaligned agent choosing a bad transaction.** The agent
constructs the request, but Inntris evaluates it and can refuse. On a BLOCK the
wallet process is never created.

**Approval reuse.** The approval token is bound to the action hash and consumed
single-use in Core before execution. A second execution needs a second approval.

**Substitution between approval and execution.** The bytes Inntris authorised
are the bytes the wallet receives. The pre-spawn recheck fails closed on any
divergence, from either a swapped buffer or a mutated parsed object.

**Fail-open on infrastructure failure.** Core unreachable, slow, malformed, or
refusing consumption all end the invocation without a wallet spawn. There is no
"Core is down, proceed anyway" branch.

**Secret leakage into the wallet process.** The `INNTRIS_` environment namespace
is stripped before the spawn.

**Accidental bypass through PATH.** If the downstream `wallet-*` binary is
itself discoverable on the same PATH, delegation is refused unless
`INNTRIS_ALLOW_DISCOVERABLE_DOWNSTREAM=true` is set explicitly.

## What it does not defend against

**Anything with local execution rights.** A process that can run the downstream
wallet binary directly, edit PATH, or change the adapter's environment is
outside this boundary. Hiding a binary from PATH is a configuration guard, not a
security boundary, and this document does not claim otherwise. Real isolation
needs the wallet to run under a different UID, in a separate container, behind a
wallet service, or on a remote signer — none of which is in Track A scope.

**A compromised Inntris agent key.** Holding `INNTRIS_PRIVATE_KEY_B64` means
being able to request approvals as that agent. Core's own policy, rate limits,
and spend reservation still apply, and every request is audited, but the key is
the adapter's identity.

**A compromised downstream wallet.** Once the wallet is invoked with an
authorised request, what it does with its own keys is beyond this adapter. The
consumption receipt proves the gate ran; it does not prove the wallet behaved.

**Settlement.** Neither an approval nor a token consumption says anything about
whether a transaction was mined, confirmed, or reverted. Post-execution
attestation is out of scope for Track A.

**Value-based limits on wallet transactions.** Track A applies chain and
recipient authority, not amount authority. A CWP transaction may express
native-token or atomic-unit value that cannot be converted to USD without an
authoritative asset-normalisation layer, and Core's existing USD-denominated
limits are deliberately left untouched rather than fed a fabricated conversion.
An allowlisted recipient can therefore be sent any amount.

**Compromise of Inntris Core itself.** Core is the authority. If it is
compromised, it can approve anything.

## Residual risks worth stating plainly

- **`USER_REJECTED` is a lossy signal.** A policy block is reported with the
  closest code the protocol has. A caller cannot distinguish "the user declined"
  from "org policy forbade this" without reading stderr or the audit log. This
  resolves when CWP gains a policy-denial code.

- **stderr diagnostics are discarded by the WalletConnect CLI.** `walletExec`
  drains provider stderr without forwarding it, so the receipt URLs do not reach
  an operator watching the CLI. `INNTRIS_AUDIT_LOG` is the workaround.

- **The info cache is a local file.** An attacker who can write
  `~/.config/inntris/downstream-info.json` can change the advertised capability
  set — but not past the intersection, which is re-applied on read, and not into
  anything the router will not gate. Such an attacker also has local execution
  rights, at which point the first bullet of the previous section applies.

- **A wallet failure after consumption spends the approval.** This is
  deliberate: the alternative — releasing a consumed token for reuse — would
  break single-use. The operator retries with a fresh approval.
