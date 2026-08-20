import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { ProtocolError } from "./protocol.js";

/**
 * The CWP request as it arrived, held in the two forms the adapter needs:
 * the original bytes (which is what gets delegated) and a single parsed view
 * (which is what gets classified and committed to Inntris).
 *
 * Both fields are mutable so the pre-spawn integrity check has something real
 * to check. Nothing in the adapter writes to them after construction; the
 * recheck exists precisely to prove that, rather than to assume it.
 */
export interface CwpInvocationInput {
  /** Verbatim stdin bytes. Forwarded to the downstream provider unchanged. */
  raw: Buffer;
  /** Parsed exactly once. Never re-serialised for delegation. */
  parsed: unknown;
  /**
   * Whether an empty body is a valid request for this operation. Carried on the
   * input so the pre-spawn recheck re-parses under exactly the same rule as the
   * original parse — a differing rule would be a false integrity failure.
   */
  allowEmpty: boolean;
}

/** Read stdin to completion, retaining the original bytes. */
export async function readStdinBuffer(stream: NodeJS.ReadStream): Promise<Buffer> {
  if (stream.isTTY) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** RFC 8785 / JCS canonical form, matching Inntris Core's `api/jcs.py`. */
export function canonicalise(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new TypeError("Value cannot be represented by RFC 8785 JCS");
  }
  return result;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** SHA-256 over the JCS canonical form. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalise(value));
}

/**
 * Parse the retained bytes into the object the invocation reasons about.
 *
 * An empty body is accepted only for operations that legitimately take none
 * (`generate`), where it means the empty object. Everywhere else empty input,
 * malformed JSON, or a non-object body is rejected here rather than passed to a
 * wallet as an un-classifiable request.
 */
export function parseRequestBody(raw: Buffer, allowEmpty: boolean): unknown {
  const text = raw.toString("utf-8").trim();
  if (text.length === 0) {
    if (allowEmpty) return {};
    throw ProtocolError.invalidInput("No JSON input received on stdin");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw ProtocolError.invalidInput("Invalid JSON input on stdin");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw ProtocolError.invalidInput("CWP input must be a JSON object");
  }
  return parsed;
}

export function parseCwpInput(raw: Buffer, allowEmpty = false): CwpInvocationInput {
  return { raw, parsed: parseRequestBody(raw, allowEmpty), allowEmpty };
}

/**
 * Pre-spawn integrity recheck (security invariant 5).
 *
 * Two independent recomputations, both compared against the hash Inntris
 * actually authorised:
 *
 * - re-parsing the retained buffer catches a swapped buffer reference, which
 *   hashing the same object twice could never detect;
 * - hashing the live parsed object catches in-place mutation of the object the
 *   authorisation was derived from.
 *
 * Either mismatch is an internal integrity failure — the process is not
 * behaving as designed — so it is exit 1 / INTERNAL_ERROR, never the exit 3
 * that means "a policy said no".
 */
export function assertDelegationIntegrity(input: CwpInvocationInput, authorisedHash: string): void {
  let reparsedHash: string;
  try {
    reparsedHash = hashCanonical(parseRequestBody(input.raw, input.allowEmpty));
  } catch {
    throw ProtocolError.internal(
      "Pre-spawn integrity check failed: retained stdin buffer is no longer parseable",
    );
  }
  if (reparsedHash !== authorisedHash) {
    throw ProtocolError.internal(
      "Pre-spawn integrity check failed: stdin bytes changed after authorisation",
    );
  }

  let liveHash: string;
  try {
    liveHash = hashCanonical(input.parsed);
  } catch {
    throw ProtocolError.internal(
      "Pre-spawn integrity check failed: parsed request is no longer canonicalisable",
    );
  }
  if (liveHash !== authorisedHash) {
    throw ProtocolError.internal(
      "Pre-spawn integrity check failed: parsed request changed after authorisation",
    );
  }
}
