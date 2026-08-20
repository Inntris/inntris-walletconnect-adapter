/**
 * Diagnostics go to stderr, never stdout.
 *
 * WalletConnect drains a provider's stderr and parses only stdout, so this is
 * where Inntris decisions become visible without contaminating the protocol
 * response (security invariant 8). Nothing here writes to stdout.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

function write(stream: NodeJS.WritableStream, message: string): void {
  stream.write(`${message}\n`);
}

export function createLogger(stderr: NodeJS.WritableStream = process.stderr): Logger {
  return {
    info(message: string): void {
      write(stderr, `[inntris] ${message}`);
    },
    warn(message: string): void {
      write(stderr, `[inntris] WARN ${message}`);
    },
  };
}

/** Logger that discards output, for tests and for silencing the info path. */
export const silentLogger: Logger = {
  info(): void {},
  warn(): void {},
};
