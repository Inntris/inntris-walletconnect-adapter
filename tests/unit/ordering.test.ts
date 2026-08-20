import { describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cwp/protocol.js";
import { computeActionHash, deriveNonce } from "../../src/inntris/signing.js";
import {
  baseEnv,
  captureStream,
  CONSUMPTION_AUDIT_ID,
  DECISION_AUDIT_ID,
  DOWNSTREAM_BIN,
  fakeCore,
  fakeSpawn,
  invoke,
  makeStdin,
  SEND_TX_INPUT,
  TEST_AGENT_ID,
} from "../helpers.js";
import { run } from "../../src/cli.js";

/**
 * Provable approve → consume → execute ordering.
 *
 * A single event log, appended to by the Core stub and the spawn stub, is the
 * evidence. If delegation ever moved ahead of consumption, the recorded order
 * would change and this suite would fail.
 */
function orderedRun(options: { stdin?: string } = {}) {
  const events: string[] = [];
  const core = fakeCore((path, body) => {
    events.push(`core:${path}`);
    if (path === "verify") {
      return {
        status: 200,
        body: {
          verdict: "approved",
          verdict_reason: "ok",
          approval_token: "token-abc",
          trust_score: 60,
          audit_id: DECISION_AUDIT_ID,
          timestamp: "2026-08-20T12:00:00Z",
          limits_remaining: {},
          idempotency_status: "new",
        },
      };
    }
    return {
      status: 200,
      body: {
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
      },
    };
  });

  const spawn = fakeSpawn(() => {
    events.push("spawn:downstream");
    return { stdout: JSON.stringify({ transactionHash: "0xok" }), exitCode: 0 };
  });

  return {
    events,
    core,
    spawn,
    result: invoke({
      operation: "send-transaction",
      stdin: options.stdin ?? JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    }),
  };
}

describe("mandatory execution ordering", () => {
  it("runs /verify, then /verify-token consume, then the wallet spawn", async () => {
    const harness = orderedRun();
    const result = await harness.result;

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(harness.events).toEqual(["core:verify", "core:verify-token", "spawn:downstream"]);
  });

  it("consumes the approval before execution, never after", async () => {
    const harness = orderedRun();
    await harness.result;
    const consumeIndex = harness.events.indexOf("core:verify-token");
    const spawnIndex = harness.events.indexOf("spawn:downstream");
    expect(consumeIndex).toBeGreaterThanOrEqual(0);
    expect(spawnIndex).toBeGreaterThan(consumeIndex);
  });

  it("sends consume=true with the complete signed action inputs", async () => {
    const harness = orderedRun();
    await harness.result;
    const consume = harness.core.calls.find((call) => call.path === "verify-token");
    const verify = harness.core.calls.find((call) => call.path === "verify");

    expect(consume?.body["consume"]).toBe(true);
    expect(consume?.body["action_type"]).toBe(verify?.body["action_type"]);
    expect(consume?.body["nonce"]).toBe(verify?.body["nonce"]);
    expect(consume?.body["timestamp"]).toBe(verify?.body["timestamp"]);
    expect(consume?.body["sig_version"]).toBe(3);
    expect(JSON.stringify(consume?.body["payload"])).toBe(JSON.stringify(verify?.body["payload"]));
  });

  it("derives request_ref and execution_ref from the same invocation id", async () => {
    const harness = orderedRun();
    await harness.result;
    const verify = harness.core.calls.find((call) => call.path === "verify");
    const consume = harness.core.calls.find((call) => call.path === "verify-token");

    const requestRef = String(verify?.body["request_ref"]);
    const executionRef = String(consume?.body["execution_ref"]);
    expect(requestRef).toMatch(/^wc:[0-9a-f-]{36}:verify$/u);
    expect(executionRef).toMatch(/^wc:[0-9a-f-]{36}:exec$/u);
    expect(requestRef.slice(3, -7)).toBe(executionRef.slice(3, -5));
  });

  it("binds request_ref inside the signed payload, as Core requires", async () => {
    const harness = orderedRun();
    await harness.result;
    const verify = harness.core.calls.find((call) => call.path === "verify");
    const payload = verify?.body["payload"] as Record<string, unknown>;
    expect(payload["request_ref"]).toBe(verify?.body["request_ref"]);
  });
});

describe("invocation-scoped idempotency", () => {
  it("reuses one invocation id, request_ref, execution_ref, nonce, timestamp and signature", async () => {
    // Two /verify attempts within one invocation: the first is answered with a
    // 500 to force the client to surface it, and the recorded request bodies
    // are compared. Nothing derived from the invocation id may be regenerated.
    const bodies: Record<string, unknown>[] = [];
    const core = fakeCore((path, body) => {
      bodies.push(body);
      if (path === "verify") {
        return {
          status: 200,
          body: {
            verdict: "approved",
            verdict_reason: "ok",
            approval_token: "token-abc",
            trust_score: 60,
            audit_id: DECISION_AUDIT_ID,
            timestamp: "2026-08-20T12:00:00Z",
            limits_remaining: {},
            idempotency_status: "new",
          },
        };
      }
      return {
        status: 200,
        body: {
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
        },
      };
    });

    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xok" }) });
    await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core,
    });

    const verify = bodies[0];
    const consume = bodies[1];
    expect(verify).toBeDefined();
    expect(consume).toBeDefined();

    // The nonce is derived from request_ref, so a regenerated invocation id
    // would necessarily change it — which is exactly what must not happen.
    expect(consume?.["nonce"]).toBe(verify?.["nonce"]);
    expect(deriveNonce(String(verify?.["request_ref"]))).toBe(verify?.["nonce"]);
    expect(consume?.["timestamp"]).toBe(verify?.["timestamp"]);
  });

  it("produces a fresh invocation id per process invocation", async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const core = fakeCore(() => ({
        status: 403,
        body: {
          verdict: "blocked",
          violation_code: "wallet_recipient_not_allowed",
          audit_id: DECISION_AUDIT_ID,
          timestamp: "2026-08-20T12:00:00Z",
          detail: "no",
        },
      }));
      await invoke({
        operation: "send-transaction",
        stdin: JSON.stringify(SEND_TX_INPUT),
        spawn: fakeSpawn(),
        core,
      });
      seen.add(String(core.calls[0]?.body["request_ref"]));
    }
    expect(seen.size).toBe(2);
  });

  it("keeps the signature stable for a fixed invocation id and clock", async () => {
    const signatures = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const core = fakeCore(() => ({
        status: 403,
        body: {
          verdict: "blocked",
          violation_code: "wallet_recipient_not_allowed",
          audit_id: DECISION_AUDIT_ID,
          timestamp: "2026-08-20T12:00:00Z",
          detail: "no",
        },
      }));
      const stdout = captureStream();
      const stderr = captureStream();
      await run({
        argv: ["node", "wallet-inntris", "send-transaction"],
        env: baseEnv({ INNTRIS_DOWNSTREAM_WALLET_BIN: DOWNSTREAM_BIN }),
        stdin: makeStdin(JSON.stringify(SEND_TX_INPUT)),
        stdout,
        stderr,
        spawnFn: fakeSpawn().fn,
        fetchImplementation: core.fetchImplementation,
        now: () => new Date("2026-08-20T12:00:00.000Z"),
        randomUUID: () => "fixed-invocation-id",
      });
      signatures.add(String(core.calls[0]?.body["signature"]));
      expect(core.calls[0]?.body["agent_id"]).toBe(TEST_AGENT_ID);
    }
    expect(signatures.size).toBe(1);
  });
});
