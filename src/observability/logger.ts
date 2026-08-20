import { appendFileSync } from "node:fs";

/**
 * Diagnostics go to stderr, never stdout.
 *
 * WalletConnect parses only stdout, so this is where Inntris decisions become
 * visible without contaminating the protocol response (security invariant 8).
 *
 * Note that `walletExec` in the WalletConnect CLI SDK *drains* a provider's
 * stderr rather than forwarding it — draining keeps a chatty provider from
 * blocking on a full pipe, but it also means these lines are discarded when
 * the adapter is invoked through the `wallet` CLI. They are visible when
 * `wallet-inntris` is invoked directly. For callers that discard stderr, set
 * INNTRIS_AUDIT_LOG to also append the same lines to a file; the decision and
 * consumption receipt URLs are the part operators actually need to keep.
 *
 * Nothing here writes to stdout.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export function createLogger(
  stderr: NodeJS.WritableStream = process.stderr,
  auditLogPath?: string,
): Logger {
  const emit = (line: string): void => {
    stderr.write(`${line}\n`);
    if (auditLogPath !== undefined && auditLogPath !== "") {
      try {
        appendFileSync(auditLogPath, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // A log sink that cannot be written must never fail an invocation.
      }
    }
  };

  return {
    info(message: string): void {
      emit(`[inntris] ${message}`);
    },
    warn(message: string): void {
      emit(`[inntris] WARN ${message}`);
    },
  };
}

/** Logger that discards output, for tests. */
export const silentLogger: Logger = {
  info(): void {},
  warn(): void {},
};
