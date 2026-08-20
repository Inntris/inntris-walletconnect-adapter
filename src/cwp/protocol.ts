/**
 * CWP wire contract: exit codes, error codes, and the stdout discipline.
 *
 * Implemented independently from the WalletConnect source per the integration
 * brief — no upstream code is copied or forked.
 */

/** Standard CWP exit codes (CAIP-397). */
export const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  UNSUPPORTED: 2,
  REJECTED: 3,
  TIMEOUT: 4,
  NOT_CONNECTED: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Error codes the current protocol defines. There is no `POLICY_DENIED`, so an
 * Inntris policy BLOCK is reported as `USER_REJECTED` / exit 3 — semantically
 * imperfect but the closest supported code. Inventing a new code would make the
 * response unintelligible to every existing CWP caller.
 */
export type WalletErrorCode =
  | "UNSUPPORTED_OPERATION"
  | "USER_REJECTED"
  | "TIMEOUT"
  | "NOT_CONNECTED"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR";

export interface CwpErrorResponse {
  error: string;
  code: WalletErrorCode;
}

/**
 * A terminal protocol outcome. Thrown by any layer that has decided the
 * invocation cannot proceed; the CLI converts it into stdout JSON plus an exit
 * code, and nothing else is written to stdout.
 */
export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCodeValue,
    readonly code: WalletErrorCode,
  ) {
    super(message);
    this.name = "ProtocolError";
  }

  toResponse(): CwpErrorResponse {
    return { error: this.message, code: this.code };
  }

  static unsupported(message: string): ProtocolError {
    return new ProtocolError(message, ExitCode.UNSUPPORTED, "UNSUPPORTED_OPERATION");
  }

  /** Inntris policy denial. Never used for internal failures. */
  static blocked(message: string): ProtocolError {
    return new ProtocolError(message, ExitCode.REJECTED, "USER_REJECTED");
  }

  static timeout(message: string): ProtocolError {
    return new ProtocolError(message, ExitCode.TIMEOUT, "TIMEOUT");
  }

  static internal(message: string): ProtocolError {
    return new ProtocolError(message, ExitCode.GENERAL_ERROR, "INTERNAL_ERROR");
  }

  static invalidInput(message: string): ProtocolError {
    return new ProtocolError(message, ExitCode.GENERAL_ERROR, "INVALID_INPUT");
  }
}

/**
 * A single monotonic deadline carried through the whole invocation.
 *
 * Per-call timeouts stay bounded regardless of how large the deadline is: a
 * 179 s `send-transaction` ceiling does not entitle an Inntris Core call to
 * 179 s. Only the downstream slice expands to absorb a larger ceiling.
 *
 * Running out of time fails closed with exit 4 (security invariant 14). The
 * adapter never starts work it cannot finish inside the caller's window,
 * because a parent-side kill would leave the caller with no protocol response
 * at all.
 */
export class Deadline {
  private constructor(
    private readonly expiresAt: number,
    private readonly clock: () => number,
  ) {}

  static fromNow(budgetMs: number, clock: () => number = () => performance.now()): Deadline {
    return new Deadline(clock() + budgetMs, clock);
  }

  remainingMs(): number {
    return Math.floor(this.expiresAt - this.clock());
  }

  /**
   * Reserve time for the next step. `minimumMs` is what that step needs at
   * minimum to be worth starting; `capMs` bounds what it may take even when
   * plenty of budget remains.
   */
  reserve(stage: string, minimumMs: number, capMs?: number): number {
    const remaining = this.remainingMs();
    if (remaining < minimumMs) {
      throw ProtocolError.timeout(
        `Insufficient time budget remaining before ${stage} (${remaining}ms left, ${minimumMs}ms required)`,
      );
    }
    return capMs === undefined ? remaining : Math.min(remaining, capMs);
  }
}
