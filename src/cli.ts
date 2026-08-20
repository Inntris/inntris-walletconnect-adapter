#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  callerCeilingMs,
  CEILING_HEADROOM_MS,
  isGatedOperation,
  isPassthroughOperation,
  isSupportedOperation,
  OPERATIONS_WITHOUT_INPUT,
} from "./cwp/operations.js";
import type { WalletErrorCode } from "./cwp/protocol.js";
import { Deadline, ExitCode, ProtocolError } from "./cwp/protocol.js";
import type { Logger } from "./observability/logger.js";
import { createLogger } from "./observability/logger.js";
import { loadDownstreamConfig, loadInntrisConfig, receiptUrl } from "./config.js";
import type { SpawnFn } from "./downstream/delegate.js";
import type { CwpInvocationInput } from "./cwp/input.js";
import type { FetchLike } from "./inntris/client.js";

/**
 * `wallet-inntris` — an Inntris CWP provider.
 *
 * Every gated operation follows one ordering, and it is a security invariant:
 *
 *     canonicalise request → sign → /verify → /verify-token (consume)
 *       → pre-spawn integrity recheck → downstream wallet
 *
 * Any failure before the last step exits without spawning the wallet. There is
 * no path through this file that reaches delegation without a consumed
 * approval token bound to the exact request being delegated.
 *
 * Heavy modules are imported lazily. Process startup sits inside
 * WalletConnect's 3 s discovery budget, and the `info` path must not pay for
 * the Inntris client, the signing code, or the Zod schemas.
 */

export interface CliDependencies {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Injected for tests; production uses global fetch. */
  fetchImplementation?: FetchLike;
  spawnFn?: SpawnFn;
  /** Wall-clock source for the signed timestamp. */
  now?: () => Date;
  /** Monotonic source for the invocation deadline. */
  clock?: () => number;
  randomUUID?: () => string;
}

interface StdoutResponse {
  body: string;
  /** A downstream provider may exit with a code outside the CWP set; relay it. */
  exitCode: number;
}

function errorResponse(message: string, code: WalletErrorCode): string {
  return JSON.stringify({ error: message, code });
}

/** Map a downstream exit code to the protocol error code that matches it. */
function codeForExit(exitCode: number): WalletErrorCode {
  switch (exitCode) {
    case ExitCode.UNSUPPORTED:
      return "UNSUPPORTED_OPERATION";
    case ExitCode.REJECTED:
      return "USER_REJECTED";
    case ExitCode.TIMEOUT:
      return "TIMEOUT";
    case ExitCode.NOT_CONNECTED:
      return "NOT_CONNECTED";
    default:
      return "INTERNAL_ERROR";
  }
}

/**
 * Turn a downstream result into this process's response.
 *
 * The downstream JSON is forwarded verbatim: no Inntris fields are injected
 * into a CWP protocol response (security invariant 8). Inntris diagnostics go
 * to stderr, which WalletConnect drains.
 */
function relayDownstream(
  result: { exitCode: number; stdout: string; stderr: string },
  logger: Logger,
): StdoutResponse {
  const text = result.stdout.trim();
  let parsed: unknown;
  let parseable = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    parseable = false;
  }
  if (result.stderr.trim() !== "") {
    logger.info(`downstream stderr: ${result.stderr.trim()}`);
  }

  if (result.exitCode === ExitCode.SUCCESS) {
    if (!parseable || typeof parsed !== "object" || parsed === null) {
      return {
        body: errorResponse("Downstream wallet provider returned malformed JSON", "INTERNAL_ERROR"),
        exitCode: ExitCode.GENERAL_ERROR,
      };
    }
    return { body: text, exitCode: ExitCode.SUCCESS };
  }

  if (parseable && typeof parsed === "object" && parsed !== null && "error" in parsed) {
    return { body: text, exitCode: result.exitCode };
  }
  return {
    body: errorResponse(
      `Downstream wallet provider exited with code ${result.exitCode}`,
      codeForExit(result.exitCode),
    ),
    exitCode: result.exitCode,
  };
}

async function handleInfo(deps: CliDependencies, logger: Logger): Promise<StdoutResponse> {
  const config = loadDownstreamConfig(deps.env);

  // A discoverable downstream is a misconfiguration, but failing `info` would
  // hide the provider entirely — a worse outcome than a loud warning. It is
  // enforced on the delegation paths instead, where it actually matters.
  const { assertDownstreamNotDiscoverable } = await import("./downstream/delegate.js");
  assertDownstreamNotDiscoverable({
    binPath: config.binPath,
    pathEnv: deps.env["PATH"],
    allowDiscoverable: config.allowDiscoverableDownstream,
    logger,
    enforce: false,
  });

  const { resolveInfo } = await import("./downstream/info-cache.js");
  const info = await resolveInfo({
    config,
    env: deps.env,
    logger,
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
  });
  return { body: JSON.stringify(info), exitCode: ExitCode.SUCCESS };
}

async function handlePassthrough(
  deps: CliDependencies,
  logger: Logger,
  operation: string,
  deadline: Deadline,
): Promise<StdoutResponse> {
  const config = loadDownstreamConfig(deps.env);
  const { assertDownstreamNotDiscoverable, delegate } = await import("./downstream/delegate.js");
  assertDownstreamNotDiscoverable({
    binPath: config.binPath,
    pathEnv: deps.env["PATH"],
    allowDiscoverable: config.allowDiscoverableDownstream,
    logger,
    enforce: true,
  });

  const { readStdinBuffer } = await import("./cwp/input.js");
  const raw = await readStdinBuffer(deps.stdin);

  const timeoutMs = Math.min(
    deadline.reserve("downstream delegation", 1),
    config.timeoutMsOverride ?? Number.MAX_SAFE_INTEGER,
  );
  logger.info(`PASSTHROUGH operation=${operation} (read-only, Inntris not consulted)`);
  const result = await delegate({
    binPath: config.binPath,
    operation,
    stdin: raw,
    timeoutMs,
    env: deps.env,
    ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
  });
  return relayDownstream(result, logger);
}

/**
 * Read the CWP request, then run the authorisation sequence over it.
 *
 * Split from `authoriseAndDelegate` so the security-critical sequence — sign,
 * verify, consume, recheck, spawn — can be driven directly over a caller-owned
 * request object without stubbing any part of it.
 */
async function handleGated(
  deps: CliDependencies,
  logger: Logger,
  operation: string,
  deadline: Deadline,
): Promise<StdoutResponse> {
  const { parseCwpInput, readStdinBuffer } = await import("./cwp/input.js");
  const raw = await readStdinBuffer(deps.stdin);
  const input = parseCwpInput(raw, OPERATIONS_WITHOUT_INPUT.has(operation));
  return authoriseAndDelegate(deps, logger, operation, deadline, input);
}

/**
 * The mandatory execution ordering for a gated operation.
 *
 *     sign → /verify → /verify-token(consume) → integrity recheck → spawn
 *
 * Every `return` and every `throw` before the final `delegate` call leaves the
 * downstream wallet unspawned. There is no branch out of this function that
 * reaches delegation without a consumed, action-bound approval.
 */
export async function authoriseAndDelegate(
  deps: CliDependencies,
  logger: Logger,
  operation: string,
  deadline: Deadline,
  input: CwpInvocationInput,
): Promise<StdoutResponse> {
  if (!isGatedOperation(operation)) {
    throw ProtocolError.unsupported(`Unsupported operation: ${operation}`);
  }

  const downstreamConfig = loadDownstreamConfig(deps.env);
  const inntrisConfig = loadInntrisConfig(deps.env);

  const { assertDownstreamNotDiscoverable, delegate } = await import("./downstream/delegate.js");
  assertDownstreamNotDiscoverable({
    binPath: downstreamConfig.binPath,
    pathEnv: deps.env["PATH"],
    allowDiscoverable: downstreamConfig.allowDiscoverableDownstream,
    logger,
    enforce: true,
  });

  const { assertDelegationIntegrity } = await import("./cwp/input.js");
  const { buildWalletAction, invocationRefs } = await import("./inntris/action.js");
  const { buildSignedAction } = await import("./inntris/signing.js");
  const { InntrisCoreClient } = await import("./inntris/client.js");

  // 1. Derive both references from a single invocation UUID, and reuse them —
  //    together with the nonce, timestamp, and signed action derived from them
  //    — for every internal retry within this invocation.
  const invocationId = (deps.randomUUID ?? crypto.randomUUID.bind(crypto))();
  const { requestRef, executionRef } = invocationRefs(invocationId);

  // 2. Commit to the exact request that will be delegated.
  const action = buildWalletAction({
    operation,
    input: input.parsed,
    requestRef,
    downstreamProvider: downstreamConfig.providerName,
  });

  // 3. Sign once. The signed action is built here and never rebuilt.
  const signed = buildSignedAction({
    agentId: inntrisConfig.agentId,
    privateKeyBase64: inntrisConfig.privateKeyBase64,
    actionType: action.actionType,
    payload: action.payload,
    requestRef,
    now: (deps.now ?? (() => new Date()))(),
  });

  const client = new InntrisCoreClient({
    coreUrl: inntrisConfig.coreUrl,
    agentId: inntrisConfig.agentId,
    coreTimeoutMs: inntrisConfig.coreTimeoutMs,
    ...(deps.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: deps.fetchImplementation }),
  });

  // 4. /verify then /verify-token(consume). Both must succeed before anything
  //    downstream is spawned.
  const decision = await client.authoriseAndConsume({ signed, executionRef, deadline });

  if (decision.outcome === "BLOCK") {
    logger.info(`BLOCK audit=${decision.decisionAuditId} violation=${decision.violationCode}`);
    logger.info(`verify=${receiptUrl(inntrisConfig.receiptBaseUrl, decision.decisionAuditId)}`);
    logger.info("downstream wallet was NOT invoked");
    return {
      body: errorResponse(decision.message, "USER_REJECTED"),
      exitCode: ExitCode.REJECTED,
    };
  }

  logger.info(
    `PASS decision=${decision.decisionAuditId} consumption=${decision.consumptionAuditId}`,
  );
  logger.info(`verify=${receiptUrl(inntrisConfig.receiptBaseUrl, decision.decisionAuditId)}`);
  logger.info(
    `consumption=${receiptUrl(inntrisConfig.receiptBaseUrl, decision.consumptionAuditId)}`,
  );

  // 5. Prove the request has not moved between authorisation and delegation.
  assertDelegationIntegrity(input, action.cwpInputHash);

  // 6. Only now may the wallet run. The downstream slice absorbs whatever the
  //    caller's ceiling left; a larger ceiling widens this step and nothing
  //    else.
  const timeoutMs = Math.min(
    deadline.reserve("downstream delegation", 1),
    downstreamConfig.timeoutMsOverride ?? Number.MAX_SAFE_INTEGER,
  );
  logger.info(`delegating to ${downstreamConfig.providerName} (${timeoutMs}ms budget)`);

  let result;
  try {
    result = await delegate({
      binPath: downstreamConfig.binPath,
      operation,
      stdin: input.raw,
      timeoutMs,
      env: deps.env,
      ...(deps.spawnFn === undefined ? {} : { spawnFn: deps.spawnFn }),
    });
  } catch (error) {
    // The approval was already consumed. That receipt proves the gate ran; it
    // does not prove settlement, and the token is not reusable for a retry.
    logger.warn(
      `execution failed AFTER authorisation was consumed ` +
        `(consumption=${decision.consumptionAuditId}); the approval token is spent`,
    );
    throw error;
  }

  if (result.exitCode !== ExitCode.SUCCESS) {
    logger.warn(
      `downstream execution failed with exit ${result.exitCode} after authorisation ` +
        `consumption=${decision.consumptionAuditId}`,
    );
  }
  return relayDownstream(result, logger);
}

/** Resolve the invocation deadline from the caller's ceiling for this operation. */
export function invocationDeadline(
  operation: string,
  env: NodeJS.ProcessEnv,
  clock: () => number,
): Deadline {
  const ceiling = callerCeilingMs(operation);
  let budget = ceiling - CEILING_HEADROOM_MS;
  const raw = env["INNTRIS_MAX_INVOCATION_MS"];
  if (raw !== undefined && raw.trim() !== "") {
    const cap = Number(raw);
    if (Number.isSafeInteger(cap) && cap > 0) budget = Math.min(budget, cap);
  }
  return Deadline.fromNow(budget, clock);
}

export async function run(deps: CliDependencies): Promise<number> {
  const logger = createLogger(deps.stderr, deps.env["INNTRIS_AUDIT_LOG"]);
  const clock = deps.clock ?? (() => performance.now());

  let response: StdoutResponse;
  try {
    const operation = deps.argv[2];
    if (operation === undefined || operation === "") {
      throw ProtocolError.unsupported("No operation supplied");
    }
    if (operation === "info") {
      response = await handleInfo(deps, logger);
    } else if (!isSupportedOperation(operation)) {
      // An unknown mutating operation is never passed through silently.
      throw ProtocolError.unsupported(`Unsupported operation: ${operation}`);
    } else {
      const deadline = invocationDeadline(operation, deps.env, clock);
      response = isPassthroughOperation(operation)
        ? await handlePassthrough(deps, logger, operation, deadline)
        : await handleGated(deps, logger, operation, deadline);
    }
  } catch (error) {
    if (error instanceof ProtocolError) {
      logger.warn(`${error.code}: ${error.message}`);
      response = { body: JSON.stringify(error.toResponse()), exitCode: error.exitCode };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`INTERNAL_ERROR: ${message}`);
      response = {
        body: errorResponse(`Inntris adapter internal error: ${message}`, "INTERNAL_ERROR"),
        exitCode: ExitCode.GENERAL_ERROR,
      };
    }
  }

  deps.stdout.write(`${response.body}\n`);
  return response.exitCode;
}

/* c8 ignore start -- process entrypoint, exercised by the integration suite */
/**
 * CWP providers are installed on PATH as a symlink to this file, and Node
 * reports the *symlink* in `process.argv[1]` while `import.meta.url` holds the
 * real path. Comparing them directly would make the entrypoint check fail for
 * every real installation, so the argv path is resolved first.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  run({
    argv: process.argv,
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `${JSON.stringify({ error: `Inntris adapter fatal error: ${message}`, code: "INTERNAL_ERROR" })}\n`,
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
    });
}
/* c8 ignore stop */
