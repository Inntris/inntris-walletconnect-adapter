import type { GatedOperation } from "../cwp/operations.js";

/**
 * Inntris runtime action types for CWP operations.
 *
 * A generic CWP transaction is deliberately NOT classified as
 * `financial_transaction`. Core's `financial_transaction` semantics are
 * USD-denominated and require a numeric spend amount; a CWP transaction may
 * express native-token or atomic-unit value that cannot be interpreted as USD
 * without an authoritative asset-normalisation layer. Faking a rate, or
 * relaxing Core's amount requirement, would both be worse than declining to
 * classify. Asset-aware amount enforcement is out of scope for Track A.
 */
export const ACTION_TYPE_BY_OPERATION: Readonly<Record<GatedOperation, string>> = {
  "send-transaction": "wallet_transaction",
  "sign-transaction": "wallet_transaction",
  fund: "wallet_transaction",
  drain: "wallet_transaction",
  swidge: "wallet_transaction",
  "sign-message": "wallet_signature",
  "sign-typed-data": "wallet_signature",
  "grant-session": "admin_action",
  "revoke-session": "admin_action",
  generate: "admin_action",
};

export const WALLET_TRANSACTION = "wallet_transaction";
export const WALLET_SIGNATURE = "wallet_signature";

export function actionTypeForOperation(operation: GatedOperation): string {
  return ACTION_TYPE_BY_OPERATION[operation];
}

/**
 * Risk flags declared alongside the action. Advisory metadata for Core's audit
 * record — the authoritative classification is `action_type`.
 */
export function riskFlagsForOperation(operation: GatedOperation): string[] {
  const actionType = actionTypeForOperation(operation);
  const flags = ["wallet"];
  if (actionType === WALLET_SIGNATURE) flags.push("signing");
  if (actionType === WALLET_TRANSACTION) flags.push("signing", "financial");
  if (actionType === "admin_action") flags.push("admin");
  return flags;
}

/**
 * Deterministic `resource_id` for an operation that may have no account.
 *
 * `generate` has no account at request time, and some admin operations carry
 * neither account nor chain. Emitting a stable placeholder beats omitting the
 * field (which would make the audit record ambiguous) or synthesising a fake
 * account (which would put a value in the audit chain that never existed).
 */
export function resourceIdFor(chain: string | undefined, account: string | undefined): string {
  if (account !== undefined && account !== "") {
    return chain !== undefined && chain !== "" ? `${chain}:${account}` : `wallet:${account}`;
  }
  if (chain !== undefined && chain !== "") return `${chain}:*`;
  return "wallet:*";
}
