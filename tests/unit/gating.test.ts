import { describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cwp/protocol.js";
import { GATED_OPERATIONS } from "../../src/cwp/operations.js";
import {
  approvingCore,
  CONSUMPTION_AUDIT_ID,
  DECISION_AUDIT_ID,
  fakeCore,
  fakeSpawn,
  invoke,
  SEND_TX_INPUT,
} from "../helpers.js";

/**
 * The blocking invariants.
 *
 * Every test in this file asserts the same thing from a different failure
 * angle: `spawn.calls` is empty. That list is direct evidence the downstream
 * wallet process was never created — not that it was created and ignored.
 */

const BLOCK_BODY = {
  verdict: "blocked",
  violation_code: "wallet_recipient_not_allowed",
  audit_id: DECISION_AUDIT_ID,
  timestamp: "2026-08-20T12:00:00Z",
  detail: "Recipient 0xBBBB is not in the configured allowlist for eip155:8453.",
  idempotency_status: "new",
};

describe("Inntris BLOCK never invokes the downstream wallet", () => {
  for (const operation of GATED_OPERATIONS) {
    it(`blocks ${operation} without spawning the wallet`, async () => {
      const spawn = fakeSpawn();
      const core = fakeCore((path) =>
        path === "verify"
          ? { status: 403, body: BLOCK_BODY }
          : { status: 200, body: { valid: false } },
      );
      const result = await invoke({
        operation,
        stdin: JSON.stringify(SEND_TX_INPUT),
        spawn,
        core,
      });

      expect(spawn.calls).toHaveLength(0);
      expect(result.exitCode).toBe(ExitCode.REJECTED);
      expect(result.json["code"]).toBe("USER_REJECTED");
      // The token endpoint is never reached on a denial: there is no approval
      // to consume.
      expect(core.calls.map((call) => call.path)).toEqual(["verify"]);
    });
  }

  it("surfaces the policy reason on stdout and the audit trail on stderr", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({ status: 403, body: BLOCK_BODY }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });

    expect(result.json["error"]).toBe("Blocked by Inntris policy: recipient is not authorised");
    expect(result.stderr).toContain(`BLOCK audit=${DECISION_AUDIT_ID}`);
    expect(result.stderr).toContain(`verify=https://inntris.com/verify/${DECISION_AUDIT_ID}`);
    expect(result.stderr).toContain("downstream wallet was NOT invoked");
    // No Inntris fields leak into the protocol response.
    expect(Object.keys(result.json).sort()).toEqual(["code", "error"]);
  });

  it("treats a rate limit as a block, not as an internal error", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({
      status: 429,
      body: { ...BLOCK_BODY, verdict: "rate_limited", violation_code: "rate_limit_exceeded" },
    }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(result.exitCode).toBe(ExitCode.REJECTED);
    expect(spawn.calls).toHaveLength(0);
  });
});

describe("Core failure never invokes the downstream wallet", () => {
  it("fails closed when Core is unavailable", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
  });

  it("fails closed on a Core timeout, with exit 4", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
    expect(result.json["code"]).toBe("TIMEOUT");
  });

  it("fails closed on a malformed approval", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({
      status: 200,
      body: { verdict: "approved", approval_token: "t" },
    }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/malformed approval/iu);
  });

  it("fails closed on a malformed denial", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({ status: 403, body: { verdict: "blocked" } }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
  });

  it("fails closed on a non-JSON Core response", async () => {
    const spawn = fakeSpawn();
    const fetchImplementation = (): Promise<Response> =>
      Promise.resolve(new Response("<html>502</html>", { status: 200 }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: { fetchImplementation, calls: [] },
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
  });

  it("fails closed on an unexpected Core HTTP status", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({ status: 500, body: { error: "boom" } }));
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
  });
});

describe("token-consumption failure never invokes the downstream wallet", () => {
  const cases: Array<[string, (body: Record<string, unknown>) => unknown]> = [
    ["consumption rejected", () => ({ valid: false, reason: "Token already used (single-use)." })],
    [
      "action hash mismatch",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: "f".repeat(64),
        action_hash_matches: true,
        consumption_audit_id: CONSUMPTION_AUDIT_ID,
        consumption_status: "consumed",
        execution_ref: body["execution_ref"],
        sandbox: false,
      }),
    ],
    [
      "action_hash_matches false",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: body["__action_hash"],
        action_hash_matches: false,
        consumption_audit_id: CONSUMPTION_AUDIT_ID,
        consumption_status: "consumed",
        execution_ref: body["execution_ref"],
        sandbox: false,
      }),
    ],
    [
      "sandbox token",
      (body) => ({
        valid: false,
        reason: "Sandbox approval tokens cannot authorize production execution.",
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: body["__action_hash"],
        action_hash_matches: true,
        sandbox: true,
      }),
    ],
    [
      "sandbox true on an otherwise valid consumption",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: body["__action_hash"],
        action_hash_matches: true,
        consumption_audit_id: CONSUMPTION_AUDIT_ID,
        consumption_status: "consumed",
        execution_ref: body["execution_ref"],
        sandbox: true,
      }),
    ],
    [
      "execution_ref mismatch",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: body["__action_hash"],
        action_hash_matches: true,
        consumption_audit_id: CONSUMPTION_AUDIT_ID,
        consumption_status: "consumed",
        execution_ref: "wc:someone-else:exec",
        sandbox: false,
      }),
    ],
    [
      "wrong agent",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: "99999999-9999-9999-9999-999999999999",
        action_hash: body["__action_hash"],
        action_hash_matches: true,
        consumption_audit_id: CONSUMPTION_AUDIT_ID,
        consumption_status: "consumed",
        execution_ref: body["execution_ref"],
        sandbox: false,
      }),
    ],
    [
      "missing consumption audit id",
      (body) => ({
        valid: true,
        verdict: "approved",
        agent_id: body["agent_id"],
        action_hash: body["__action_hash"],
        action_hash_matches: true,
        consumption_audit_id: null,
        consumption_status: "consumed",
        execution_ref: body["execution_ref"],
        sandbox: false,
      }),
    ],
  ];

  for (const [name, tokenBody] of cases) {
    it(`fails closed: ${name}`, async () => {
      const spawn = fakeSpawn();
      const core = approvingCore({ tokenBody });
      const result = await invoke({
        operation: "send-transaction",
        stdin: JSON.stringify(SEND_TX_INPUT),
        spawn,
        core,
      });
      expect(spawn.calls).toHaveLength(0);
      expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect(result.json["code"]).toBe("INTERNAL_ERROR");
    });
  }
});

describe("budget exhaustion fails closed", () => {
  it("exits 4 without delegating when no time remains before the wallet spawn", async () => {
    const spawn = fakeSpawn();
    // A monotonic clock that stays put through both Core calls and then jumps
    // past the ceiling, so the deadline is exhausted exactly at the delegation
    // step: reading 1 sets the deadline, 2 and 3 are the /verify and
    // /verify-token reservations, and 4 is the pre-spawn reservation.
    let reading = 0;
    const clock = (): number => {
      reading += 1;
      return reading <= 3 ? 0 : 500_000;
    };
    const core = approvingCore();
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      clock,
    });

    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
    expect(result.json["code"]).toBe("TIMEOUT");
  });

  it("honours an operator invocation cap tighter than the caller ceiling", async () => {
    const spawn = fakeSpawn();
    let reading = 0;
    const clock = (): number => {
      reading += 1;
      // First read establishes the deadline; the second is already past a 1ms cap.
      return reading === 1 ? 0 : 10_000;
    };
    const core = approvingCore();
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      clock,
      env: { INNTRIS_MAX_INVOCATION_MS: "1" },
    });
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
  });
});
