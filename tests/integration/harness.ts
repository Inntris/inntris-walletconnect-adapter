import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

/**
 * The published WalletConnect CWP CLI (`wallet`), at the same version as the
 * pinned agent-sdk commit. Taken from node_modules rather than reimplemented,
 * so the discovery, capability filtering, timeout table, and exit-code mapping
 * exercised here are WalletConnect's own.
 *
 * Addressed by path because the package's `exports` map does not expose the
 * `wallet` entry point for import — it is published as a bin, and a bin is
 * what this harness runs.
 */
export const WALLET_CLI = join(
  resolve(import.meta.dirname, "..", ".."),
  "node_modules",
  "@walletconnect",
  "cli-sdk",
  "dist",
  "cwp-cli.js",
);

export interface WalletRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the WalletConnect CLI asynchronously.
 *
 * Asynchronous on purpose: the Inntris Core stub these tests point the adapter
 * at runs inside this same process, so a synchronous spawn would block the
 * event loop and the stub could never accept the connection.
 */
export function runWallet(
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdin?: string },
): Promise<WalletRun> {
  return new Promise<WalletRun>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WALLET_CLI, ...args], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}
