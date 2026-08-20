import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_CWP_OPERATIONS } from "../cwp/operations.js";
import { ProtocolError } from "../cwp/protocol.js";
import type { DownstreamConfig } from "../config.js";
import type { Logger } from "../observability/logger.js";
import type { SpawnFn } from "./delegate.js";
import { childEnvironment } from "./delegate.js";

/**
 * Resolving the `info` descriptor.
 *
 * This path runs inside WalletConnect's 3 s discovery budget while spawning a
 * second Node process from inside the first, so it is built to degrade rather
 * than fail: a provider whose `info` call fails is recorded with `info: null`
 * by discovery and is effectively invisible, which is a worse outcome than a
 * slightly stale capability list.
 *
 * It never contacts Inntris Core. `info` is not a gated operation and must not
 * depend on Core availability (security invariant 15).
 */

/** Hard cap on the downstream `info` spawn, well inside the 3 s budget. */
export const DOWNSTREAM_INFO_TIMEOUT_MS = 1_500;

export const ADAPTER_NAME = "inntris";
export const ADAPTER_RDNS = "com.inntris.wallet";

export interface AdapterInfoResponse {
  name: string;
  version: string;
  rdns: string;
  capabilities: string[];
  chains: string[];
}

interface DownstreamDescriptor {
  capabilities: string[];
  chains: string[];
}

interface CacheEntry extends DownstreamDescriptor {
  /** Full cache key. A descriptor is served only when all three still match. */
  bin_path: string;
  bin_mtime_ms: number;
  adapter_version: string;
}

/** Read this package's version; used in the response and in the cache key. */
export function adapterVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/downstream/info-cache.js -> dist/../package.json
    const pkg: unknown = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf-8"),
    );
    if (typeof pkg === "object" && pkg !== null) {
      const version = (pkg as Record<string, unknown>)["version"];
      if (typeof version === "string" && version !== "") return version;
    }
  } catch {
    // Fall through: a missing package.json must not break discovery.
  }
  return "0.0.0";
}

/**
 * Intersect the downstream capability set with what this shim can route.
 *
 * The intersection matters in both directions: do not claim what the downstream
 * cannot do, and do not claim what the shim cannot route. The shim fails an
 * unknown operation with exit 2, so advertising an unrouted capability would
 * convert a clean unsupported-operation response into a caller-visible failure
 * on an operation WalletConnect was told would work.
 *
 * Applied on every path — live, cached, and static fallback alike (security
 * invariant 16).
 */
export function intersectCapabilities(downstream: readonly string[]): string[] {
  const advertised = new Set(downstream);
  return SUPPORTED_CWP_OPERATIONS.filter((operation) => advertised.has(operation));
}

function readCache(path: string, key: Omit<CacheEntry, "capabilities" | "chains">):
  | DownstreamDescriptor
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const entry = parsed as Record<string, unknown>;
  if (
    entry["bin_path"] !== key.bin_path ||
    entry["bin_mtime_ms"] !== key.bin_mtime_ms ||
    entry["adapter_version"] !== key.adapter_version
  ) {
    return undefined;
  }
  const capabilities = entry["capabilities"];
  const chains = entry["chains"];
  if (!isStringArray(capabilities) || !isStringArray(chains)) return undefined;
  return { capabilities, chains };
}

function writeCache(path: string, entry: CacheEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(entry), { mode: 0o600 });
  } catch {
    // A cache that cannot be written is a performance problem, not a
    // correctness one. The next invocation simply resolves live again.
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Spawn the downstream provider's own `info` with a hard timeout. */
function downstreamInfo(
  binPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<DownstreamDescriptor | undefined> {
  return new Promise<DownstreamDescriptor | undefined>((resolve) => {
    let child;
    try {
      child = spawnFn(binPath, ["info"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: childEnvironment(env),
      });
    } catch {
      resolve(undefined);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: DownstreamDescriptor | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", () => {
      // Drained so a chatty provider cannot block on a full pipe.
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(undefined);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        finish(undefined);
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        finish(undefined);
        return;
      }
      const record = parsed as Record<string, unknown>;
      const capabilities = record["capabilities"];
      const chains = record["chains"];
      if (!isStringArray(capabilities) || !isStringArray(chains)) {
        finish(undefined);
        return;
      }
      finish({ capabilities, chains });
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}

/**
 * Resolve the descriptor `wallet-inntris info` returns.
 *
 * Order: cache (on a full key match) → live downstream call → static fallback.
 * Only a live call populates the cache.
 */
export async function resolveInfo(params: {
  config: DownstreamConfig;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  version?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}): Promise<AdapterInfoResponse> {
  const version = params.version ?? adapterVersion();
  const timeoutMs = params.timeoutMs ?? DOWNSTREAM_INFO_TIMEOUT_MS;
  const binPath = params.config.binPath;

  let mtimeMs = 0;
  try {
    mtimeMs = Math.floor(statSync(binPath).mtimeMs);
  } catch {
    // A stat failure leaves mtime 0, which simply never matches a stored key.
  }
  const key = { bin_path: binPath, bin_mtime_ms: mtimeMs, adapter_version: version };

  let descriptor = readCache(params.config.infoCachePath, key);
  let source: "cache" | "downstream" | "fallback" = "cache";

  if (descriptor === undefined) {
    descriptor = await downstreamInfo(binPath, params.env, timeoutMs, params.spawnFn ?? spawn);
    if (descriptor !== undefined) {
      source = "downstream";
      writeCache(params.config.infoCachePath, { ...key, ...descriptor });
    }
  }

  if (descriptor === undefined) {
    if (params.config.infoFallback === undefined) {
      throw ProtocolError.internal(
        `Could not resolve downstream provider "${params.config.providerName}" capabilities ` +
          `and no INNTRIS_DOWNSTREAM_INFO_FALLBACK is configured`,
      );
    }
    descriptor = params.config.infoFallback;
    source = "fallback";
    params.logger.warn(
      `downstream "${params.config.providerName}" info unavailable; using static fallback`,
    );
  }

  params.logger.info(`info source=${source} provider=${params.config.providerName}`);

  const capabilities = intersectCapabilities(descriptor.capabilities);
  if (capabilities.length === 0) {
    throw ProtocolError.internal(
      `Downstream provider "${params.config.providerName}" advertises no capability that ` +
        `wallet-inntris can route; refusing to register a provider that can do nothing`,
    );
  }

  return {
    name: ADAPTER_NAME,
    version,
    rdns: ADAPTER_RDNS,
    capabilities,
    // Chains pass through unmodified. Chain restriction is per-agent wallet
    // policy evaluated at Core; narrowing the advertised list here would leak
    // agent policy into a discovery response and go stale the moment the
    // policy changes.
    chains: [...descriptor.chains],
  };
}
