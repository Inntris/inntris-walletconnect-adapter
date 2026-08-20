import { z } from "zod";

/**
 * The wallet policy document stored under an Inntris agent's metadata as
 * `metadata.wallet_policy`, and the violation codes Core returns when it is
 * enforced.
 *
 * Enforcement lives in Inntris Core (`api/policy.py`) — this module is the
 * adapter-side contract: it validates a policy before it is written by the
 * demo tooling, and translates Core's violation codes into the human-readable
 * message the CWP caller sees on a BLOCK. It is not a second policy engine and
 * never decides PASS/BLOCK.
 */

const Caip2ChainSchema = z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u, {
  message: "chain must be a CAIP-2 identifier such as eip155:8453",
});

export const WalletPolicySchema = z
  .object({
    allowed_chains: z.array(Caip2ChainSchema).min(1).optional(),
    allowed_recipients: z.record(Caip2ChainSchema, z.array(z.string().min(1))).optional(),
  })
  .strict();

export type WalletPolicy = z.infer<typeof WalletPolicySchema>;

/** Violation codes Core emits for the wallet policy. */
export const WALLET_VIOLATIONS = {
  CHAIN_NOT_ALLOWED: "wallet_chain_not_allowed",
  RECIPIENT_NOT_ALLOWED: "wallet_recipient_not_allowed",
  RECIPIENT_REQUIRED: "wallet_recipient_required",
  POLICY_INVALID: "wallet_policy_invalid",
} as const;

const BLOCK_MESSAGES: Readonly<Record<string, string>> = {
  [WALLET_VIOLATIONS.CHAIN_NOT_ALLOWED]: "chain is not authorised for this agent",
  [WALLET_VIOLATIONS.RECIPIENT_NOT_ALLOWED]: "recipient is not authorised",
  [WALLET_VIOLATIONS.RECIPIENT_REQUIRED]:
    "recipient is required by the configured recipient allowlist",
  [WALLET_VIOLATIONS.POLICY_INVALID]: "the configured wallet policy is invalid",
  action_not_allowed: "this action type is not permitted for this agent",
  action_blocked: "this action type is explicitly blocked for this agent",
  agent_not_active: "the agent is not active",
  trust_score_too_low: "the agent's trust score is below the threshold for this action",
  rate_limit_exceeded: "the agent's rate limit was exceeded",
  daily_limit_exceeded: "the agent's daily limit would be exceeded",
  per_action_limit_exceeded: "the amount exceeds the agent's per-action limit",
  timestamp_invalid: "the request timestamp is outside the accepted clock skew",
};

/**
 * The message surfaced on stdout for an Inntris BLOCK.
 *
 * Falls back to the violation code itself rather than a generic string: an
 * unmapped code is still more useful to an operator than "policy denied".
 */
export function blockMessageFor(violationCode: string, detail?: string): string {
  const known = BLOCK_MESSAGES[violationCode];
  if (known !== undefined) return `Blocked by Inntris policy: ${known}`;
  if (detail !== undefined && detail.trim() !== "") {
    return `Blocked by Inntris policy: ${detail}`;
  }
  return `Blocked by Inntris policy: ${violationCode}`;
}
