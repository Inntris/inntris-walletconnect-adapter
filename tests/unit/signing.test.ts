import { readFileSync } from "node:fs";
import { join } from "node:path";

import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { hashCanonical } from "../../src/cwp/input.js";
import {
  buildSignedAction,
  computeActionHash,
  deriveNonce,
  signActionHash,
  SIG_VERSION,
} from "../../src/inntris/signing.js";
import type { InntrisWalletPayload } from "../../src/inntris/action.js";

/**
 * Cross-language signing contract.
 *
 * These vectors were produced by Inntris Core's own
 * `CryptoService.compute_action_hash(sig_version=3)` and signed with the same
 * seed. If the adapter reproduces the action hash *and* the signature
 * byte-for-byte, Core will accept its requests.
 */
interface SigningCase {
  name: string;
  action_type: string;
  payload: Record<string, unknown>;
  nonce: string;
  timestamp: string;
  payload_hash: string;
  action_hash: string;
  signature: string;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "core_signing_vectors.json"), "utf-8"),
) as { agent_id: string; seed_b64: string; sig_version: number; cases: SigningCase[] };

describe("Inntris signing envelope v3 against Core vectors", () => {
  it("pins sig_version 3", () => {
    expect(SIG_VERSION).toBe(3);
    expect(fixture.sig_version).toBe(3);
  });

  for (const testCase of fixture.cases) {
    it(`reproduces Core's payload hash: ${testCase.name}`, () => {
      expect(hashCanonical(testCase.payload)).toBe(testCase.payload_hash);
    });

    it(`reproduces Core's action hash: ${testCase.name}`, () => {
      expect(
        computeActionHash({
          agentId: fixture.agent_id,
          actionType: testCase.action_type,
          payload: testCase.payload,
          nonce: testCase.nonce,
          timestamp: testCase.timestamp,
        }),
      ).toBe(testCase.action_hash);
    });

    it(`reproduces Core's Ed25519 signature: ${testCase.name}`, () => {
      expect(signActionHash(fixture.seed_b64, testCase.action_hash)).toBe(testCase.signature);
    });

    it(`signs the hex-decoded hash, not its ASCII form: ${testCase.name}`, () => {
      const seed = Buffer.from(fixture.seed_b64, "base64");
      const pair = nacl.sign.keyPair.fromSeed(seed);
      const signature = Buffer.from(testCase.signature, "base64");
      // What Core verifies.
      expect(
        nacl.sign.detached.verify(
          Buffer.from(testCase.action_hash, "hex"),
          signature,
          pair.publicKey,
        ),
      ).toBe(true);
      // The mistake this guards against.
      expect(
        nacl.sign.detached.verify(
          Buffer.from(testCase.action_hash, "utf-8"),
          signature,
          pair.publicKey,
        ),
      ).toBe(false);
    });
  }
});

describe("nonce derivation", () => {
  it("is deterministic in the request_ref", () => {
    expect(deriveNonce("wc:abc:verify")).toBe(deriveNonce("wc:abc:verify"));
  });

  it("differs across invocations", () => {
    expect(deriveNonce("wc:abc:verify")).not.toBe(deriveNonce("wc:def:verify"));
  });

  it("fits Core's 64-character nonce limit exactly", () => {
    expect(deriveNonce("wc:abc:verify")).toHaveLength(64);
  });
});

const samplePayload: InntrisWalletPayload = {
  platform: "walletconnect-cwp",
  rail: "walletconnect_cwp",
  trust_level: "external_cwp_provider",
  resource: "wallet",
  resource_id: "eip155:8453:0xA",
  operation: "send-transaction",
  payload_hash: "a".repeat(64),
  request_ref: "wc:abc:verify",
  downstream_provider: "companion",
  risk_flags: ["wallet"],
  policy_context: { cwp_operation: "send-transaction" },
};

describe("buildSignedAction", () => {
  const seed = Buffer.alloc(32, 7).toString("base64");

  it("emits the full signed request with sig_version 3", () => {
    const built = buildSignedAction({
      agentId: "agent-1",
      privateKeyBase64: seed,
      actionType: "wallet_transaction",
      payload: samplePayload,
      requestRef: "wc:abc:verify",
      now: new Date("2026-08-20T12:00:00.000Z"),
    });
    expect(built.request.sig_version).toBe(3);
    expect(built.request.request_ref).toBe("wc:abc:verify");
    expect(built.request.nonce).toBe(deriveNonce("wc:abc:verify"));
    expect(built.request.timestamp).toBe("2026-08-20T12:00:00Z");
    expect(built.actionHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("is fully deterministic for the same invocation inputs", () => {
    const args = {
      agentId: "agent-1",
      privateKeyBase64: seed,
      actionType: "wallet_transaction",
      payload: samplePayload,
      requestRef: "wc:abc:verify",
      now: new Date("2026-08-20T12:00:00.000Z"),
    };
    expect(buildSignedAction(args)).toStrictEqual(buildSignedAction(args));
  });

  it("rejects a seed that is not 32 bytes", () => {
    expect(() =>
      buildSignedAction({
        agentId: "agent-1",
        privateKeyBase64: Buffer.alloc(16, 1).toString("base64"),
        actionType: "wallet_transaction",
        payload: samplePayload,
        requestRef: "wc:abc:verify",
        now: new Date(),
      }),
    ).toThrow(/Ed25519 seed must be 32 bytes/u);
  });

  it("never carries key material on the returned object", () => {
    const built = buildSignedAction({
      agentId: "agent-1",
      privateKeyBase64: seed,
      actionType: "wallet_transaction",
      payload: samplePayload,
      requestRef: "wc:abc:verify",
      now: new Date(),
    });
    expect(JSON.stringify(built)).not.toContain(seed);
  });
});
