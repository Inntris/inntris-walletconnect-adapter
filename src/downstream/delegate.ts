import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { ProtocolError } from "../cwp/protocol.js";
import type { Logger } from "../observability/logger.js";

/** Secrets stripped from the child environment before the wallet is spawned. */
const INNTRIS_SECRET_ENV_KEYS = ["INNTRIS_PRIVATE_KEY_B64"] as const;

export interface DownstreamResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = typeof spawn;

/**
 * Build the child environment.
 *
 * The Inntris signing key must never reach the wallet process (security
 * invariant 9). The whole `INNTRIS_*` namespace is dropped rather than just the
 * key: a downstream wallet has no legitimate use for the adapter's Core URL,
 * agent id, or budgets, and dropping the namespace means a future secret-valued
 * setting is excluded by default instead of by remembering to add it here.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("INNTRIS_")) continue;
    result[key] = value;
  }
  for (const key of INNTRIS_SECRET_ENV_KEYS) {
    delete result[key];
  }
  return result;
}

/**
 * Refuse to run when the downstream wallet is itself discoverable on PATH.
 *
 * CWP discovery takes the first `wallet-*` match on PATH. If the real wallet is
 * also on that PATH, an agent can address it directly and Inntris is simply not
 * in the path — the governed route becomes one option among two.
 *
 * This is a configuration check, not an OS security boundary: it prevents an
 * accidental bypass, not a determined one. Host isolation (separate UID,
 * container, wallet service, or remote signer) is what actually enforces this
 * in production.
 */
export function assertDownstreamNotDiscoverable(params: {
  binPath: string;
  pathEnv: string | undefined;
  allowDiscoverable: boolean;
  logger: Logger;
  enforce: boolean;
}): void {
  const target = basename(params.binPath);
  if (!target.startsWith("wallet-")) return;

  const found = findOnPath(target, params.pathEnv);
  if (found === undefined) return;

  const message =
    `Downstream provider "${target}" is directly discoverable on PATH at ${found}. ` +
    `CWP discovery would reach it without traversing Inntris. Remove it from the ` +
    `WalletConnect-facing PATH, or set INNTRIS_ALLOW_DISCOVERABLE_DOWNSTREAM=true ` +
    `for local development.`;

  if (params.allowDiscoverable) {
    params.logger.warn(message);
    return;
  }
  if (!params.enforce) {
    params.logger.warn(message);
    return;
  }
  throw ProtocolError.internal(message);
}

function findOnPath(binary: string, pathEnv: string | undefined): string | undefined {
  for (const dir of (pathEnv ?? "").split(":")) {
    if (dir === "") continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (!entries.includes(binary)) continue;
    const full = join(dir, binary);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Invoke the downstream CWP provider.
 *
 * The retained stdin bytes are forwarded verbatim — the parsed object is never
 * re-serialised. Re-serialising would introduce a second representation of the
 * request whose relationship to the authorised hash is an assumption rather
 * than a fact.
 *
 * `shell: false` and a single argv entry: no string is ever handed to a shell.
 */
export function delegate(params: {
  binPath: string;
  operation: string;
  stdin: Buffer;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}): Promise<DownstreamResult> {
  const spawnFn = params.spawnFn ?? spawn;
  return new Promise<DownstreamResult>((resolve, reject) => {
    const child = spawnFn(params.binPath, [params.operation], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: childEnvironment(params.env),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        ProtocolError.timeout(
          `Downstream provider timed out after ${params.timeoutMs}ms`,
        ),
      );
    }, params.timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // stderr is drained rather than ignored: an undrained pipe can block a
    // child that writes more than the buffer holds.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message =
        error.code === "ENOENT"
          ? `Downstream wallet provider not found: ${params.binPath}`
          : `Failed to spawn downstream wallet provider: ${error.message}`;
      reject(ProtocolError.internal(message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin?.on("error", () => {
      // A provider that exits before reading stdin closes the pipe; the exit
      // code it already produced is the outcome that matters.
    });
    child.stdin?.end(params.stdin);
  });
}
