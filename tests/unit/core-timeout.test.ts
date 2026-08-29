import { describe, expect, it } from "vitest";

import { loadInntrisConfig } from "../../src/config.js";
import { Deadline, ExitCode, ProtocolError } from "../../src/cwp/protocol.js";
import {
  callerCeilingMs,
  CEILING_HEADROOM_MS,
  DEFAULT_CALLER_CEILING_MS,
} from "../../src/cwp/operations.js";
import { computeActionHash } from "../../src/inntris/signing.js";
import {
  approvingCore,
  baseEnv,
  CONSUMPTION_AUDIT_ID,
  DECISION_AUDIT_ID,
  fakeCore,
  fakeSpawn,
  invoke,
  SEND_TX_INPUT,
} from "../helpers.js";

/**
 * The Inntris Core per-call timeout.
 *
 * Production `/verify` has answered correctly in ~3.7 s under load while the
 * adapter's default cap was 2.5 s, so an *authorised* transaction surfaced to
 * WalletConnect as a client-side timeout and never reached `/verify-token` or
 * the wallet. Core was healthy throughout and recorded the correct decision.
 *
 * The default is now 10 s. These tests pin both halves of that change: the cap
 * is wide enough for the latency Core actually exhibits, and exceeding it is
 * still a fail-closed timeout that leaves the downstream wallet unspawned.
 */

/** The two `/verify` latencies observed in the production incident. */
const PRODUCTION_AUTHORISED_LATENCY_MS = 3_700;
const PRODUCTION_BLOCKED_LATENCY_MS = 2_400;

/** The default this suite exists to defend, and the default it replaced. */
const EXPECTED_DEFAULT_CORE_TIMEOUT_MS = 10_000;
const PREVIOUS_DEFAULT_CORE_TIMEOUT_MS = 2_500;

const BLOCK_BODY = {
  verdict: "blocked",
  violation_code: "wallet_recipient_not_allowed",
  audit_id: DECISION_AUDIT_ID,
  timestamp: "2026-08-20T12:00:00Z",
  detail: "Recipient 0xBBBB is not in the configured allowlist for eip155:8453.",
  idempotency_status: "new",
};

/**
 * Resolve after `ms`, or reject exactly as `fetch` does when its abort signal
 * fires first.
 *
 * Honouring the signal is the point: it makes the stub model a slow Core rather
 * than a fast one, so a cap narrower than the latency really does abort the
 * request instead of merely being recorded in configuration.
 */
function afterLatency<T>(ms: number, signal: AbortSignal | null | undefined, value: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, ms);
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * The `/verify-token` body Core returns, with the action hash recomputed from
 * the supplied parameters exactly as Core does, so the client's binding
 * assertions are exercised for real rather than against a hard-coded echo.
 */
function consumptionBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    valid: true,
    verdict: "approved",
    agent_id: body["agent_id"],
    action_hash: computeActionHash({
      agentId: String(body["agent_id"]),
      actionType: String(body["action_type"]),
      payload: body["payload"],
      nonce: String(body["nonce"]),
      timestamp: String(body["timestamp"]),
    }),
    expires_at: "2026-08-20T12:05:00Z",
    action_hash_matches: true,
    consumption_audit_id: CONSUMPTION_AUDIT_ID,
    consumption_status: "consumed",
    execution_ref: body["execution_ref"],
    sandbox: false,
  };
}

/** An approving Core whose endpoints answer only after the given latency. */
function slowApprovingCore(latencyMs: Partial<Record<"verify" | "verify-token", number>>) {
  const events: string[] = [];
  const core = fakeCore(async (path, body, signal) => {
    events.push(`core:${path}`);
    const response =
      path === "verify"
        ? {
            status: 200,
            body: {
              verdict: "approved",
              verdict_reason: "All verification checks passed",
              approval_token: "token-abc",
              trust_score: 60,
              audit_id: DECISION_AUDIT_ID,
              timestamp: "2026-08-20T12:00:00Z",
              limits_remaining: {},
              idempotency_status: "new",
            },
          }
        : { status: 200, body: consumptionBody(body) };
    const delay = latencyMs[path as "verify" | "verify-token"] ?? 0;
    return delay > 0 ? afterLatency(delay, signal, response) : response;
  });
  return { core, events };
}

describe("Inntris Core timeout configuration", () => {
  it("defaults to 10000 ms", () => {
    expect(loadInntrisConfig(baseEnv()).coreTimeoutMs).toBe(EXPECTED_DEFAULT_CORE_TIMEOUT_MS);
  });

  it("admits the ~3.7s /verify latency observed in production", () => {
    // The regression this change exists to prevent: the old default sat below
    // the latency Core legitimately exhibits under load.
    expect(PREVIOUS_DEFAULT_CORE_TIMEOUT_MS).toBeLessThan(PRODUCTION_AUTHORISED_LATENCY_MS);
    expect(loadInntrisConfig(baseEnv()).coreTimeoutMs).toBeGreaterThan(
      PRODUCTION_AUTHORISED_LATENCY_MS,
    );
  });

  it("stays far inside the caller ceiling for the slowest gated operation", () => {
    // Two Core calls plus the downstream slice must all fit under the ceiling
    // WalletConnect imposes on send-transaction.
    const budget = callerCeilingMs("send-transaction") - CEILING_HEADROOM_MS;
    expect(EXPECTED_DEFAULT_CORE_TIMEOUT_MS * 2).toBeLessThan(budget);
  });

  it("is still bounded by the invocation deadline, not the other way round", () => {
    // Operations that inherit the 10 s caller ceiling get a 9 s budget, so the
    // deadline — not the raised cap — is what limits their Core calls.
    const budget = DEFAULT_CALLER_CEILING_MS - CEILING_HEADROOM_MS;
    const deadline = Deadline.fromNow(budget, () => 0);
    expect(deadline.reserve("Inntris /verify", 1, EXPECTED_DEFAULT_CORE_TIMEOUT_MS)).toBe(budget);
    expect(budget).toBeLessThan(EXPECTED_DEFAULT_CORE_TIMEOUT_MS);
  });

  it("lets an operator override the default in either direction", () => {
    expect(loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: "45000" })).coreTimeoutMs).toBe(
      45_000,
    );
    expect(loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: "2500" })).coreTimeoutMs).toBe(
      2_500,
    );
  });

  it("falls back to the default when the override is unset or blank", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: raw })).coreTimeoutMs).toBe(
        EXPECTED_DEFAULT_CORE_TIMEOUT_MS,
      );
    }
  });

  it("rejects a non-positive or non-integer override rather than defaulting", () => {
    // A misconfigured cap must fail configuration validation, not silently
    // become the default — an operator who typed "0" did not ask for 10 s.
    for (const raw of ["0", "-1", "-2500", "abc", "1.5", "NaN", "Infinity", "10_000"]) {
      expect(() => loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: raw }))).toThrow(
        ProtocolError,
      );
      expect(() => loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: raw }))).toThrow(
        /INNTRIS_CORE_TIMEOUT_MS must be a positive integer/u,
      );
    }
  });

  it("reports an invalid override as exit 1 INTERNAL_ERROR", () => {
    try {
      loadInntrisConfig(baseEnv({ INNTRIS_CORE_TIMEOUT_MS: "0" }));
      expect.unreachable("invalid timeout must not load");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect((error as ProtocolError).code).toBe("INTERNAL_ERROR");
    }
  });
});

describe("production Core latency no longer aborts locally", () => {
  it("completes an authorised send-transaction when /verify takes ~3.7s", async () => {
    const { core, events } = slowApprovingCore({ verify: PRODUCTION_AUTHORISED_LATENCY_MS });
    const spawn = fakeSpawn(() => {
      events.push("spawn:downstream");
      return { stdout: JSON.stringify({ transactionHash: "0xok" }), exitCode: 0 };
    });

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.json["transactionHash"]).toBe("0xok");
    // The ordering invariant is unchanged: verify, then consume, then the wallet.
    expect(events).toEqual(["core:verify", "core:verify-token", "spawn:downstream"]);
    expect(spawn.calls).toHaveLength(1);
    const consume = core.calls.find((call) => call.path === "verify-token");
    expect(consume?.body["consume"]).toBe(true);
  });

  it("still blocks an unauthorised transaction that is denied after ~2.4s", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(async (path, _body, signal) =>
      path === "verify"
        ? afterLatency(PRODUCTION_BLOCKED_LATENCY_MS, signal, {
            status: 403,
            body: BLOCK_BODY,
          })
        : { status: 200, body: { valid: false } },
    );

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });

    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.REJECTED);
    expect(result.json["code"]).toBe("USER_REJECTED");
    // A denial is never followed by a consumption attempt.
    expect(core.calls.map((call) => call.path)).toEqual(["verify"]);
    expect(result.stderr).toContain("downstream wallet was NOT invoked");
  });
});

describe("exceeding the Core cap still fails closed", () => {
  it("exits 4 TIMEOUT without spawning the wallet when /verify overruns the cap", async () => {
    const spawn = fakeSpawn();
    const { core } = slowApprovingCore({ verify: 60_000 });

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      env: { INNTRIS_CORE_TIMEOUT_MS: "50" },
    });

    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
    expect(result.json["code"]).toBe("TIMEOUT");
    expect(result.json["error"]).toMatch(/\/verify timed out/u);
    // Nothing was consumed: the approval leg never returned.
    expect(core.calls.map((call) => call.path)).toEqual(["verify"]);
  });

  it("exits 4 TIMEOUT without spawning the wallet when /verify-token overruns the cap", async () => {
    const spawn = fakeSpawn();
    const { core } = slowApprovingCore({ "verify-token": 60_000 });

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      env: { INNTRIS_CORE_TIMEOUT_MS: "50" },
    });

    // An approval that was never confirmed as consumed does not authorise a spawn.
    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
    expect(result.json["code"]).toBe("TIMEOUT");
    expect(result.json["error"]).toMatch(/\/verify-token timed out/u);
    expect(core.calls.map((call) => call.path)).toEqual(["verify", "verify-token"]);
  });

  it("applies the operator override to the live request, not just to configuration", async () => {
    // A latency the 10 s default would tolerate must still abort under a
    // tighter operator cap, which proves the configured value reaches the
    // abort signal rather than being recorded and ignored.
    const spawn = fakeSpawn();
    const { core } = slowApprovingCore({ verify: 2_000 });

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      env: { INNTRIS_CORE_TIMEOUT_MS: "100" },
    });

    expect(spawn.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
  });

  it("refuses to load an invalid cap and never reaches Core or the wallet", async () => {
    const spawn = fakeSpawn();
    const core = approvingCore();

    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
      env: { INNTRIS_CORE_TIMEOUT_MS: "0" },
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
    expect(core.calls).toHaveLength(0);
    expect(spawn.calls).toHaveLength(0);
  });
});
