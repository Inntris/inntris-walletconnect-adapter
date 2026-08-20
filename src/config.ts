import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { ProtocolError } from "./cwp/protocol.js";

/** Bin name this package installs as, and the name it must never delegate to. */
export const ADAPTER_BIN_NAME = "wallet-inntris";

const DEFAULT_CORE_TIMEOUT_MS = 2_500;
const DEFAULT_PROVIDER_NAME = "companion";
const DEFAULT_RECEIPT_BASE_URL = "https://inntris.com/verify";

export interface DownstreamConfig {
  /** Absolute path to the downstream `wallet-*` executable. */
  binPath: string;
  /** Short provider name recorded in the signed Inntris action. */
  providerName: string;
  /** Optional operator cap on the downstream slice of the budget. */
  timeoutMsOverride: number | undefined;
  /** Development escape hatch for the PATH-discoverability check (§11). */
  allowDiscoverableDownstream: boolean;
  /** Static descriptor used when downstream `info` cannot be resolved. */
  infoFallback: StaticInfoFallback | undefined;
  /** Where the resolved downstream descriptor is cached. */
  infoCachePath: string;
}

export interface StaticInfoFallback {
  capabilities: string[];
  chains: string[];
}

export interface InntrisConfig {
  coreUrl: URL;
  agentId: string;
  privateKeyBase64: string;
  coreTimeoutMs: number;
  receiptBaseUrl: string;
  /** Optional operator cap on the whole invocation, tighter than the ceiling. */
  maxInvocationMsOverride: number | undefined;
}

export type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw ProtocolError.internal(`Missing required configuration: ${key}`);
  }
  return value.trim();
}

function optionalPositiveInt(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw ProtocolError.internal(`${key} must be a positive integer (got ${raw})`);
  }
  return value;
}

function boolFlag(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "true" || normalised === "1") return true;
  if (normalised === "false" || normalised === "0") return false;
  throw ProtocolError.internal(`${key} must be "true" or "false" (got ${raw})`);
}

function parseInfoFallback(env: Env): StaticInfoFallback | undefined {
  const raw = env["INNTRIS_DOWNSTREAM_INFO_FALLBACK"];
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ProtocolError.internal("INNTRIS_DOWNSTREAM_INFO_FALLBACK must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw ProtocolError.internal("INNTRIS_DOWNSTREAM_INFO_FALLBACK must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const capabilities = record["capabilities"];
  const chains = record["chains"];
  if (!isStringArray(capabilities) || !isStringArray(chains)) {
    throw ProtocolError.internal(
      "INNTRIS_DOWNSTREAM_INFO_FALLBACK must contain string arrays 'capabilities' and 'chains'",
    );
  }
  return { capabilities, chains };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validate the downstream binary. An absolute path that exists and is
 * executable, and is not this adapter — a shim that can delegate to itself
 * would recurse until the caller's timeout, with Inntris re-authorising at
 * every level.
 */
function resolveDownstreamBin(env: Env): string {
  const binPath = required(env, "INNTRIS_DOWNSTREAM_WALLET_BIN");
  if (!isAbsolute(binPath)) {
    throw ProtocolError.internal(
      `INNTRIS_DOWNSTREAM_WALLET_BIN must be an absolute path (got ${binPath})`,
    );
  }
  let stats;
  try {
    stats = statSync(binPath);
  } catch {
    throw ProtocolError.internal(`Downstream wallet binary does not exist: ${binPath}`);
  }
  if (!stats.isFile()) {
    throw ProtocolError.internal(`Downstream wallet binary is not a file: ${binPath}`);
  }
  try {
    accessSync(binPath, constants.X_OK);
  } catch {
    throw ProtocolError.internal(`Downstream wallet binary is not executable: ${binPath}`);
  }
  if (basename(binPath) === ADAPTER_BIN_NAME) {
    throw ProtocolError.internal(
      `Downstream wallet binary must not be ${ADAPTER_BIN_NAME} — refusing to delegate to self`,
    );
  }
  return binPath;
}

/**
 * The subset of configuration the `info` path needs.
 *
 * Deliberately excludes every Inntris Core setting: `info` must answer without
 * Core reachability, and must not fail because a signing key is absent
 * (security invariant 15).
 */
export function loadDownstreamConfig(env: Env = process.env): DownstreamConfig {
  return {
    binPath: resolveDownstreamBin(env),
    providerName: env["INNTRIS_DOWNSTREAM_PROVIDER_NAME"]?.trim() || DEFAULT_PROVIDER_NAME,
    timeoutMsOverride: optionalPositiveInt(env, "INNTRIS_DOWNSTREAM_TIMEOUT_MS"),
    allowDiscoverableDownstream: boolFlag(env, "INNTRIS_ALLOW_DISCOVERABLE_DOWNSTREAM", false),
    infoFallback: parseInfoFallback(env),
    infoCachePath:
      env["INNTRIS_INFO_CACHE_PATH"]?.trim() ||
      join(homedir(), ".config", "inntris", "downstream-info.json"),
  };
}

/** Configuration for the Inntris Core authority calls. Loaded lazily. */
export function loadInntrisConfig(env: Env = process.env): InntrisConfig {
  const rawUrl = required(env, "INNTRIS_CORE_URL");
  let coreUrl: URL;
  try {
    coreUrl = new URL(rawUrl);
  } catch {
    throw ProtocolError.internal(`INNTRIS_CORE_URL is not a valid URL (got ${rawUrl})`);
  }
  if (coreUrl.protocol !== "https:" && coreUrl.protocol !== "http:") {
    throw ProtocolError.internal(`INNTRIS_CORE_URL must be http(s) (got ${coreUrl.protocol})`);
  }

  const privateKeyBase64 = required(env, "INNTRIS_PRIVATE_KEY_B64");
  // Validate the seed length here so a misconfigured key fails before any
  // network call, rather than surfacing as an opaque signature rejection.
  const seedLength = Buffer.from(privateKeyBase64, "base64").byteLength;
  if (seedLength !== 32) {
    throw ProtocolError.internal(
      `INNTRIS_PRIVATE_KEY_B64 must decode to a 32-byte Ed25519 seed (got ${seedLength} bytes)`,
    );
  }

  return {
    coreUrl,
    agentId: required(env, "INNTRIS_AGENT_ID"),
    privateKeyBase64,
    coreTimeoutMs: optionalPositiveInt(env, "INNTRIS_CORE_TIMEOUT_MS") ?? DEFAULT_CORE_TIMEOUT_MS,
    receiptBaseUrl: env["INNTRIS_RECEIPT_BASE_URL"]?.trim() || DEFAULT_RECEIPT_BASE_URL,
    maxInvocationMsOverride: optionalPositiveInt(env, "INNTRIS_MAX_INVOCATION_MS"),
  };
}

export function receiptUrl(base: string, auditId: string): string {
  return `${base.replace(/\/$/u, "")}/${encodeURIComponent(auditId)}`;
}
