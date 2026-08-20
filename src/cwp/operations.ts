/**
 * The CWP operation surface `wallet-inntris` implements.
 *
 * `SUPPORTED_CWP_OPERATIONS` is the single source of truth: the router uses it
 * to decide whether an operation is known, and the `info` path intersects the
 * downstream provider's advertised capabilities with it. Both import this
 * constant so the two can never drift — advertising an operation the router
 * would reject turns a clean exit-2 into a caller-visible failure on an
 * operation WalletConnect was told would work.
 */

/** Operations delegated straight to the downstream provider. */
export const PASSTHROUGH_OPERATIONS = [
  "accounts",
  "balance",
  "history",
  "get-session",
] as const;

/** Operations that MUST traverse Inntris before the downstream provider runs. */
export const GATED_OPERATIONS = [
  "sign-message",
  "sign-typed-data",
  "sign-transaction",
  "send-transaction",
  "grant-session",
  "revoke-session",
  "generate",
  "fund",
  "drain",
  "swidge",
] as const;

export type PassthroughOperation = (typeof PASSTHROUGH_OPERATIONS)[number];
export type GatedOperation = (typeof GATED_OPERATIONS)[number];
export type SupportedOperation = PassthroughOperation | GatedOperation;

/**
 * Every operation `wallet-inntris` can route. `info` is deliberately absent:
 * it is answered locally rather than routed, and the CWP `capabilities` array
 * never advertises it (the reference companion-wallet omits it too).
 */
export const SUPPORTED_CWP_OPERATIONS: readonly SupportedOperation[] = [
  ...PASSTHROUGH_OPERATIONS,
  ...GATED_OPERATIONS,
];

const PASSTHROUGH_SET: ReadonlySet<string> = new Set(PASSTHROUGH_OPERATIONS);
const GATED_SET: ReadonlySet<string> = new Set(GATED_OPERATIONS);
const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_CWP_OPERATIONS);

export function isSupportedOperation(value: string): value is SupportedOperation {
  return SUPPORTED_SET.has(value);
}

export function isPassthroughOperation(value: string): value is PassthroughOperation {
  return PASSTHROUGH_SET.has(value);
}

export function isGatedOperation(value: string): value is GatedOperation {
  return GATED_SET.has(value);
}

/**
 * Hard ceilings the *caller* imposes on the `wallet-inntris` spawn, verified
 * against WalletConnect/agent-sdk at commit 1e80df8.
 *
 * - `discovery.ts` calls `info` with a 3 s budget (not in this table; the
 *   `info` path never reaches the invocation-deadline logic).
 * - `cwp-cli.ts` carries an explicit timeouts table for five operations.
 * - Everything else reaching a provider through `walletExec` gets its 10 s
 *   default.
 *
 * There is deliberately no universal total budget: the ceilings differ by two
 * orders of magnitude and a fixed cap would manufacture failures on
 * `send-transaction` that the protocol does not have.
 */
export const CALLER_CEILING_MS: Readonly<Record<string, number>> = {
  accounts: 10_000,
  "sign-message": 120_000,
  "sign-typed-data": 120_000,
  "sign-transaction": 120_000,
  "send-transaction": 180_000,
};

/** Budget applied to any operation absent from `CALLER_CEILING_MS`. */
export const DEFAULT_CALLER_CEILING_MS = 10_000;

/**
 * Headroom reserved inside the caller's ceiling so the adapter can emit a
 * protocol-shaped error before the parent kills the process.
 */
export const CEILING_HEADROOM_MS = 1_000;

export function callerCeilingMs(operation: string): number {
  return CALLER_CEILING_MS[operation] ?? DEFAULT_CALLER_CEILING_MS;
}
