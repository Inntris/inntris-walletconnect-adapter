import { describe, expect, it } from "vitest";

import { buildWalletAction, invocationRefs } from "../../src/inntris/action.js";
import type { GatedOperation } from "../../src/cwp/operations.js";

/**
 * Exact-action binding.
 *
 * The approval Inntris issues must be bound to the precise CWP request that
 * will be delegated. Every field a caller could vary has to move the hash; a
 * field that does not move the hash is a field an attacker could change after
 * approval without invalidating it.
 */

const BASE_INPUT = {
  account: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  chain: "eip155:8453",
  transaction: {
    to: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    value: "0x2386f26fc10000",
    data: "0x",
  },
};

function hashFor(operation: GatedOperation, input: unknown): string {
  return buildWalletAction({
    operation,
    input,
    requestRef: "wc:fixed:verify",
    downstreamProvider: "companion",
  }).cwpInputHash;
}

function payloadFor(operation: GatedOperation, input: unknown) {
  return buildWalletAction({
    operation,
    input,
    requestRef: "wc:fixed:verify",
    downstreamProvider: "companion",
  }).payload;
}

describe("exact-action binding", () => {
  const baseline = hashFor("send-transaction", BASE_INPUT);

  it("is stable for an identical request", () => {
    expect(hashFor("send-transaction", structuredClone(BASE_INPUT))).toBe(baseline);
  });

  it("is stable across key ordering (JCS canonicalisation)", () => {
    const reordered = {
      transaction: { data: "0x", value: "0x2386f26fc10000", to: BASE_INPUT.transaction.to },
      chain: BASE_INPUT.chain,
      account: BASE_INPUT.account,
    };
    expect(hashFor("send-transaction", reordered)).toBe(baseline);
  });

  it("changes when the account changes", () => {
    const mutated = { ...BASE_INPUT, account: "0x1111111111111111111111111111111111111111" };
    expect(hashFor("send-transaction", mutated)).not.toBe(baseline);
  });

  it("changes when the chain changes", () => {
    const mutated = { ...BASE_INPUT, chain: "eip155:1" };
    expect(hashFor("send-transaction", mutated)).not.toBe(baseline);
  });

  it("changes when transaction.to changes", () => {
    const mutated = {
      ...BASE_INPUT,
      transaction: { ...BASE_INPUT.transaction, to: "0x9999999999999999999999999999999999999999" },
    };
    expect(hashFor("send-transaction", mutated)).not.toBe(baseline);
  });

  it("changes when transaction.value changes", () => {
    const mutated = {
      ...BASE_INPUT,
      transaction: { ...BASE_INPUT.transaction, value: "0x1" },
    };
    expect(hashFor("send-transaction", mutated)).not.toBe(baseline);
  });

  it("changes when transaction.data changes", () => {
    const mutated = {
      ...BASE_INPUT,
      transaction: { ...BASE_INPUT.transaction, data: "0xdeadbeef" },
    };
    expect(hashFor("send-transaction", mutated)).not.toBe(baseline);
  });

  it("changes the signed payload when the operation changes", () => {
    // The input hash covers stdin only; the operation is bound through the
    // payload's `operation` field and through `action_type`.
    const a = payloadFor("send-transaction", BASE_INPUT);
    const b = payloadFor("sign-transaction", BASE_INPUT);
    expect(a.operation).toBe("send-transaction");
    expect(b.operation).toBe("sign-transaction");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("changes when the message changes", () => {
    const one = hashFor("sign-message", { account: "0xA", message: "approve payment" });
    const two = hashFor("sign-message", { account: "0xA", message: "approve payments" });
    expect(one).not.toBe(two);
  });

  it("changes when typedData changes", () => {
    const typedData = {
      domain: { name: "Test", chainId: 8453 },
      types: { Order: [{ name: "amount", type: "uint256" }] },
      primaryType: "Order",
      message: { amount: "1" },
    };
    const one = hashFor("sign-typed-data", { account: "0xA", typedData });
    const two = hashFor("sign-typed-data", {
      account: "0xA",
      typedData: { ...typedData, message: { amount: "2" } },
    });
    expect(one).not.toBe(two);
  });

  it("commits the complete input, including fields it does not extract", () => {
    const withExtra = { ...BASE_INPUT, sessionId: "session-9" };
    expect(hashFor("send-transaction", withExtra)).not.toBe(baseline);
  });
});

describe("signed payload contents", () => {
  it("carries the rail and trust-boundary identifiers", () => {
    const payload = payloadFor("send-transaction", BASE_INPUT);
    expect(payload.platform).toBe("walletconnect-cwp");
    expect(payload.rail).toBe("walletconnect_cwp");
    expect(payload.trust_level).toBe("external_cwp_provider");
  });

  it("extracts chain, account and recipient for EVM transactions", () => {
    const payload = payloadFor("send-transaction", BASE_INPUT);
    expect(payload.chain).toBe("eip155:8453");
    expect(payload.account).toBe(BASE_INPUT.account);
    expect(payload.recipient).toBe(BASE_INPUT.transaction.to);
  });

  it("omits recipient when it cannot be derived, rather than guessing", () => {
    const payload = payloadFor("send-transaction", {
      account: "0xA",
      chain: "eip155:8453",
      transaction: { value: "0x1" },
    });
    expect(payload.recipient).toBeUndefined();
    expect("recipient" in payload).toBe(false);
  });

  it("does not extract a recipient for signature operations", () => {
    const payload = payloadFor("sign-message", { account: "0xA", message: "hi" });
    expect("recipient" in payload).toBe(false);
  });

  it("carries no key Core would read as a spend amount", () => {
    const payload = payloadFor("send-transaction", BASE_INPUT) as unknown as Record<
      string,
      unknown
    >;
    for (const field of ["amount", "amount_usd", "value", "total"]) {
      expect(field in payload).toBe(false);
    }
  });

  it("does not copy raw signing material into the audit chain", () => {
    const secret = "TRANSFER ALL FUNDS TO 0xBAD";
    const payload = payloadFor("sign-message", { account: "0xA", message: secret });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it("binds request_ref inside the signed payload", () => {
    const payload = payloadFor("send-transaction", BASE_INPUT);
    expect(payload.request_ref).toBe("wc:fixed:verify");
  });
});

describe("resource_id", () => {
  it("uses chain:account when both are present", () => {
    expect(payloadFor("send-transaction", BASE_INPUT).resource_id).toBe(
      `eip155:8453:${BASE_INPUT.account}`,
    );
  });

  it("uses chain:* when the chain is present but the account is not", () => {
    expect(payloadFor("grant-session", { chain: "eip155:8453" }).resource_id).toBe("eip155:8453:*");
  });

  it("uses wallet:* when neither is present", () => {
    expect(payloadFor("generate", {}).resource_id).toBe("wallet:*");
  });

  it("uses wallet:account when the account is present without a chain", () => {
    expect(payloadFor("sign-message", { account: "0xA", message: "x" }).resource_id).toBe(
      "wallet:0xA",
    );
  });
});

describe("invocation references", () => {
  it("derives both references from one invocation id", () => {
    const refs = invocationRefs("abc-123");
    expect(refs.requestRef).toBe("wc:abc-123:verify");
    expect(refs.executionRef).toBe("wc:abc-123:exec");
  });
});
