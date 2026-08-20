import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";

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

      const resolved =
        typeof behaviour === "function" ? behaviour(args[0] ?? "") : behaviour;

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
) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** A Core stand-in that records the call order alongside the responses. */
export function fakeCore(handler: CoreHandler): FakeCore {
  const calls: CoreCall[] = [];
  const fetchImplementation = async (input: string, init: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\//u, "");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const result = await handler(path, body);
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
