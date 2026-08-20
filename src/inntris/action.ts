import type { GatedOperation } from "../cwp/operations.js";
import { hashCanonical } from "../cwp/input.js";
import { ProtocolError } from "../cwp/protocol.js";
import {
  actionTypeForOperation,
  resourceIdFor,
  riskFlagsForOperation,
  WALLET_TRANSACTION,
} from "../policy/mapping.js";

/**
 * The payload signed and sent to Inntris `/verify`.
 *
 * Field discipline:
 *
 * - `payload_hash` commits to the *complete* CWP input, so the approval is
 *   bound to the exact request that will be delegated. Extracted fields exist
 *   only so Core can evaluate policy on them; they never replace the hash.
 * - No raw signing material appears here. A plaintext message or typed-data
 *   body is committed through `payload_hash` rather than copied into the audit
 *   chain.
 * - No key named `amount`, `amount_usd`, `value`, or `total` appears at the top
 *   level. Core's `_extract_amount` scans exactly those names, and a stray one
 *   would pull a CWP transaction into USD spend accounting it has no basis for.
 */
export interface InntrisWalletPayload {
  platform: "walletconnect-cwp";
  rail: "walletconnect_cwp";
  trust_level: "external_cwp_provider";
  resource: "wallet";
  resource_id: string;
  operation: GatedOperation;
  payload_hash: string;
  request_ref: string;
  downstream_provider: string;
  risk_flags: string[];
  policy_context: { cwp_operation: GatedOperation };
  chain?: string;
  account?: string;
  recipient?: string;
}

export interface BuiltAction {
  actionType: string;
  payload: InntrisWalletPayload;
  /** SHA-256 over the JCS form of the complete CWP input. */
  cwpInputHash: string;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Extract the EVM recipient from a transaction-shaped CWP input.
 *
 * Only `transaction.to` counts. Guessing a recipient from any other field would
 * mean Core evaluates its allowlist against something the wallet will not
 * actually pay, so an unreadable transaction yields `undefined` and the
 * recipient-required rule in Core decides what happens next.
 */
function extractRecipient(input: Record<string, unknown>): string | undefined {
  const transaction = input["transaction"];
  if (typeof transaction !== "object" || transaction === null || Array.isArray(transaction)) {
    return undefined;
  }
  return optionalString(transaction as Record<string, unknown>, "to");
}

/**
 * Build the Inntris action for a gated CWP operation.
 *
 * `input` is the parsed CWP request, read but never modified.
 */
export function buildWalletAction(params: {
  operation: GatedOperation;
  input: unknown;
  requestRef: string;
  downstreamProvider: string;
}): BuiltAction {
  const { operation, input, requestRef, downstreamProvider } = params;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw ProtocolError.invalidInput("CWP input must be a JSON object");
  }
  const record = input as Record<string, unknown>;

  const chain = optionalString(record, "chain");
  const account = optionalString(record, "account");
  const actionType = actionTypeForOperation(operation);
  const recipient = actionType === WALLET_TRANSACTION ? extractRecipient(record) : undefined;

  const payload: InntrisWalletPayload = {
    platform: "walletconnect-cwp",
    rail: "walletconnect_cwp",
    trust_level: "external_cwp_provider",
    resource: "wallet",
    resource_id: resourceIdFor(chain, account),
    operation,
    payload_hash: hashCanonical(input),
    request_ref: requestRef,
    downstream_provider: downstreamProvider,
    risk_flags: riskFlagsForOperation(operation),
    policy_context: { cwp_operation: operation },
    // Only fields with a deterministic meaning are lifted out of the input.
    // Absent fields are omitted rather than nulled so the canonical payload
    // stays stable across operation shapes.
    ...(chain === undefined ? {} : { chain }),
    ...(account === undefined ? {} : { account }),
    ...(recipient === undefined ? {} : { recipient }),
  };

  return { actionType, payload, cwpInputHash: payload.payload_hash };
}

/** Derive the invocation-scoped references from a single UUID. */
export function invocationRefs(invocationId: string): {
  requestRef: string;
  executionRef: string;
} {
  return {
    requestRef: `wc:${invocationId}:verify`,
    executionRef: `wc:${invocationId}:exec`,
  };
}
