import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";

import { computeActionHash } from "../src/inntris/signing.js";
import type { SpawnFn } from "../src/downstream/delegate.js";
import type { CliDependencies } from "../src/cli.js";

/** A stdin stand-in that yields `text` and reports itself as non-TTY. */
export function makeStdin(text: string): NodeJS.ReadStream {
  const stream = Readable.from([Buffer.from(text, "utf-8")]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  return stream;
}

export interface Captured extends Writable {
  text(): string;
}

export function captureStream(): Captured {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as Captured;
  stream.text = () => Buffer.concat(chunks).toString("utf-8");
  return stream;
}

export interface SpawnRecord {
  binPath: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
}

export interface FakeSpawn {
  fn: SpawnFn;
  /** Every downstream invocation, in order. Length 0 proves no wallet ran. */
  calls: SpawnRecord[];
}

export interface FakeChildBehaviour {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Delay before the child closes, for timeout tests. */
  delayMs?: number;
  /** Emit a spawn error instead of running. */
  error?: NodeJS.ErrnoException;
}

/**
 * A spawn stand-in that records every invocation.
 *
 * The recorded call list is what the blocking tests assert on: an empty list is
 * direct evidence the downstream wallet was never invoked.
 */
export function fakeSpawn(
  behaviour: FakeChildBehaviour | ((operation: string) => FakeChildBehaviour) = {},
): FakeSpawn {
  const calls: SpawnRecord[] = [];
  const fn = ((binPath: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let killed = false;
    child.kill = () => {
      killed = true;
      return true;
    };

    const stdinChunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => stdinChunks.push(Buffer.from(chunk)));
    child.stdin.on("finish", () => {
      const record: SpawnRecord = {
        binPath,
        args,
        stdin: Buffer.concat(stdinChunks).toString("utf-8"),
        env: options.env ?? {},
      };
      calls.push(record);

      const resolved = typeof behaviour === "function" ? behaviour(args[0] ?? "") : behaviour;

      if (resolved.error !== undefined) {
        setImmediate(() => child.emit("error", resolved.error));
        return;
      }

      const emit = (): void => {
        if (killed) return;
        if (resolved.stdout !== undefined) child.stdout.write(resolved.stdout);
        if (resolved.stderr !== undefined) child.stderr.write(resolved.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", resolved.exitCode ?? 0);
      };
      if (resolved.delayMs !== undefined && resolved.delayMs > 0) {
        const timer = setTimeout(emit, resolved.delayMs);
        timer.unref?.();
      } else {
        setImmediate(emit);
      }
    });
    return child;
  }) as unknown as SpawnFn;

  return { fn, calls };
}

export interface CoreCall {
  path: string;
  body: Record<string, unknown>;
}

export interface FakeCore {
  fetchImplementation: NonNullable<CliDependencies["fetchImplementation"]>;
  /** Every Inntris Core call, in order. */
  calls: CoreCall[];
}

export type CoreHandler = (
  path: string,
  body: Record<string, unknown>,
  /** The per-call abort signal, so a handler can model a slow Core faithfully. */
  signal: AbortSignal | null | undefined,
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** A Core stand-in that records the call order alongside the responses. */
export function fakeCore(handler: CoreHandler): FakeCore {
  const calls: CoreCall[] = [];
  const fetchImplementation = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\//u, "");
    const body = JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    calls.push({ path, body });
    const result = await handler(path, body, init.signal);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImplementation, calls };
}

/** A deterministic 32-byte Ed25519 seed, base64 — test material only. */
export const TEST_SEED_B64 = Buffer.alloc(32, 7).toString("base64");
export const TEST_AGENT_ID = "11111111-2222-3333-4444-555555555555";

export function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/nonexistent-path-for-tests",
    INNTRIS_CORE_URL: "https://core.test.invalid",
    INNTRIS_AGENT_ID: TEST_AGENT_ID,
    INNTRIS_PRIVATE_KEY_B64: TEST_SEED_B64,
    INNTRIS_DOWNSTREAM_PROVIDER_NAME: "companion",
    ...overrides,
  };
}

export const DOWNSTREAM_BIN = new URL("./fixtures/wallet-downstream-stub", import.meta.url)
  .pathname;

export interface InvokeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

export interface InvokeOptions {
  operation: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FakeSpawn;
  core?: FakeCore;
  now?: () => Date;
  clock?: () => number;
  randomUUID?: () => string;
}

/** Drive the real CLI in-process with injected Core, spawn, and clocks. */
export async function invoke(options: InvokeOptions): Promise<InvokeResult> {
  const { run } = await import("../src/cli.js");
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await run({
    argv: ["node", "wallet-inntris", options.operation],
    env: baseEnv({ INNTRIS_DOWNSTREAM_WALLET_BIN: DOWNSTREAM_BIN, ...options.env }),
    stdin: makeStdin(options.stdin ?? ""),
    stdout,
    stderr,
    ...(options.spawn === undefined ? {} : { spawnFn: options.spawn.fn }),
    ...(options.core === undefined
      ? {}
      : { fetchImplementation: options.core.fetchImplementation }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.randomUUID === undefined ? {} : { randomUUID: options.randomUUID }),
  });
  const text = stdout.text().trim();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* stdout is deliberately non-JSON in some negative tests */
  }
  return { exitCode, stdout: text, stderr: stderr.text(), json };
}

/** A valid `send-transaction` body used across the gating suites. */
export const SEND_TX_INPUT = {
  account: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  chain: "eip155:8453",
  transaction: {
    to: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    value: "0x2386f26fc10000",
    data: "0x",
  },
};

export const DECISION_AUDIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const CONSUMPTION_AUDIT_ID = "11111111-2222-4333-8444-999999999999";

/** A Core that approves and confirms exact action-bound consumption. */
export function approvingCore(
  overrides: {
    verifyStatus?: number;
    verifyBody?: unknown;
    tokenBody?: (body: Record<string, unknown>) => unknown;
    onConsume?: () => void;
  } = {},
): FakeCore {
  return fakeCore((path, body) => {
    if (path === "verify") {
      return {
        status: overrides.verifyStatus ?? 200,
        body: overrides.verifyBody ?? {
          verdict: "approved",
          verdict_reason: "All verification checks passed",
          approval_token: "token-abc",
          trust_score: 60,
          audit_id: DECISION_AUDIT_ID,
          timestamp: "2026-08-20T12:00:00Z",
          limits_remaining: {},
          idempotency_status: "new",
        },
      };
    }
    overrides.onConsume?.();
    // Recompute the action hash from the supplied parameters exactly as Core
    // does, so the binding assertions in the client are exercised for real
    // rather than against a hard-coded echo.
    const actionHash = computeActionHash({
      agentId: String(body["agent_id"]),
      actionType: String(body["action_type"]),
      payload: body["payload"],
      nonce: String(body["nonce"]),
      timestamp: String(body["timestamp"]),
    });
    const defaultToken = {
      valid: true,
      verdict: "approved",
      agent_id: body["agent_id"],
      action_hash: actionHash,
      expires_at: "2026-08-20T12:05:00Z",
      action_hash_matches: true,
      consumption_audit_id: CONSUMPTION_AUDIT_ID,
      consumption_status: "consumed",
      execution_ref: body["execution_ref"],
      sandbox: false,
    };
    return {
      status: 200,
      body:
        overrides.tokenBody === undefined
          ? defaultToken
          : overrides.tokenBody({ ...body, __action_hash: actionHash }),
    };
  });
}
