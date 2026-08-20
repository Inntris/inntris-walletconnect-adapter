import nacl from "tweetnacl";

import { canonicalise, sha256Hex } from "../cwp/input.js";
import { ProtocolError } from "../cwp/protocol.js";
import type { InntrisWalletPayload } from "./action.js";

/**
 * Inntris request signing, envelope version 3.
 *
 * This mirrors `CryptoService.compute_action_hash` in Inntris Core
 * (`api/crypto.py`) for `sig_version == 3`, and follows the proven sequence
 * already in production in the Highnote adapter:
 *
 *     payload_hash = SHA-256(JCS(payload))
 *     action_hash  = SHA-256(JCS({agent_id, action_type, payload_hash,
 *                                 nonce, timestamp}))
 *     signature    = Ed25519(bytes.fromhex(action_hash))
 *
 * Signing the *hex-decoded bytes* of the action hash — not its ASCII form — is
 * the part that silently breaks if reimplemented from memory; Core verifies
 * against `bytes.fromhex(message_hash)`.
 *
 * This is request authentication only. The adapter never issues its own
 * verdict receipts: Inntris Core is the evidence authority.
 */

export const SIG_VERSION = 3 as const;

export interface SignedCoreAction {
  agent_id: string;
  action_type: string;
  payload: InntrisWalletPayload;
  signature: string;
  nonce: string;
  timestamp: string;
  sig_version: typeof SIG_VERSION;
  request_ref: string;
}

export interface BuiltSignedAction {
  request: SignedCoreAction;
  actionHash: string;
}

/**
 * Render a timestamp the way Python's `datetime.isoformat()` does after
 * `canonicalize_timestamp`, so both sides hash identical bytes.
 *
 * Python emits no fractional part at zero microseconds and six digits
 * otherwise; JavaScript's `toISOString()` always emits three. Both forms are
 * normalised here rather than in Core, because Core is the side that must not
 * change.
 */
export function canonicalCoreTimestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw ProtocolError.internal("Cannot canonicalise an invalid timestamp");
  }
  const iso = parsed.toISOString();
  if (parsed.getUTCMilliseconds() === 0) return iso.replace(".000Z", "Z");
  return iso.replace(/\.(\d{3})Z$/u, ".$1000Z");
}

/**
 * Deterministic nonce derived from the invocation's `request_ref`.
 *
 * A random nonce would change on every internal retry, and a retry that
 * presents a different nonce is a different signed action — which defeats the
 * durable idempotency `request_ref` exists to provide. Core claims
 * `(agent_id, request_ref)` before it consumes the nonce, so replaying the
 * identical signed request on a retry replays the stored response instead of
 * tripping replay protection.
 */
export function deriveNonce(requestRef: string): string {
  return sha256Hex(`inntris-walletconnect-nonce-v1:${requestRef}`);
}

/**
 * Compute the `sig_version = 3` action hash.
 *
 * Exported so the cross-language vectors generated from Core's own
 * `CryptoService.compute_action_hash` can be asserted directly, rather than
 * only through the full signing path.
 */
export function computeActionHash(params: {
  agentId: string;
  actionType: string;
  payload: unknown;
  nonce: string;
  timestamp: string;
}): string {
  const payloadHash = sha256Hex(canonicalise(params.payload));
  return sha256Hex(
    canonicalise({
      agent_id: params.agentId,
      action_type: params.actionType,
      payload_hash: payloadHash,
      nonce: params.nonce,
      timestamp: params.timestamp,
    }),
  );
}

/**
 * Sign the hex-decoded action hash with the agent's Ed25519 key.
 *
 * The seed and derived secret key are zeroed before this returns. Neither is
 * retained anywhere, and neither is ever exported to the downstream process.
 */
export function signActionHash(privateKeyBase64: string, actionHash: string): string {
  const seed = Buffer.from(privateKeyBase64, "base64");
  if (seed.byteLength !== nacl.sign.seedLength) {
    seed.fill(0);
    throw ProtocolError.internal(
      `Ed25519 seed must be ${nacl.sign.seedLength} bytes (got ${seed.byteLength})`,
    );
  }
  try {
    const pair = nacl.sign.keyPair.fromSeed(seed);
    try {
      return Buffer.from(
        nacl.sign.detached(Buffer.from(actionHash, "hex"), pair.secretKey),
      ).toString("base64");
    } finally {
      pair.secretKey.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

/**
 * Build the complete signed request for `/verify`.
 *
 * Called exactly once per invocation: the returned object is reused for
 * `/verify-token` and for any internal retry, so the nonce, timestamp, and
 * signature never change mid-invocation.
 */
export function buildSignedAction(params: {
  agentId: string;
  privateKeyBase64: string;
  actionType: string;
  payload: InntrisWalletPayload;
  requestRef: string;
  now: Date;
}): BuiltSignedAction {
  const nonce = deriveNonce(params.requestRef);
  const timestamp = canonicalCoreTimestamp(params.now);
  const actionHash = computeActionHash({
    agentId: params.agentId,
    actionType: params.actionType,
    payload: params.payload,
    nonce,
    timestamp,
  });
  const signature = signActionHash(params.privateKeyBase64, actionHash);
  return {
    actionHash,
    request: {
      agent_id: params.agentId,
      action_type: params.actionType,
      payload: params.payload,
      signature,
      nonce,
      timestamp,
      sig_version: SIG_VERSION,
      request_ref: params.requestRef,
    },
  };
}
