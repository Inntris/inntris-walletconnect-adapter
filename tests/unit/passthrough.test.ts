import { describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cwp/protocol.js";
import { PASSTHROUGH_OPERATIONS } from "../../src/cwp/operations.js";
import { approvingCore, fakeCore, fakeSpawn, invoke, SEND_TX_INPUT } from "../helpers.js";

/** Read-only operations reach the wallet directly and never consult Inntris. */
describe("pass-through operations", () => {
  for (const operation of PASSTHROUGH_OPERATIONS) {
    it(`${operation} does not call Inntris`, async () => {
      const spawn = fakeSpawn({ stdout: JSON.stringify({ accounts: [] }) });
      const core = fakeCore(() => {
        throw new Error("Inntris must not be called for a read-only operation");
      });
      const result = await invoke({ operation, stdin: "{}", spawn, core });

      expect(core.calls).toHaveLength(0);
      expect(spawn.calls).toHaveLength(1);
      expect(result.exitCode).toBe(ExitCode.SUCCESS);
    });
  }

  it("forwards the operation as a single argv entry", async () => {
    const spawn = fakeSpawn({ stdout: "{}" });
    await invoke({ operation: "accounts", spawn });
    expect(spawn.calls[0]?.args).toEqual(["accounts"]);
  });

  it("forwards stdin bytes verbatim", async () => {
    const spawn = fakeSpawn({ stdout: "{}" });
    const body = JSON.stringify({ account: "0xA", chain: "eip155:8453" });
    await invoke({ operation: "balance", stdin: body, spawn });
    expect(spawn.calls[0]?.stdin).toBe(body);
  });

  it("tolerates an empty stdin body", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ accounts: [] }) });
    const result = await invoke({ operation: "accounts", stdin: "", spawn });
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(spawn.calls[0]?.stdin).toBe("");
  });
});

describe("output compatibility", () => {
  it("returns the downstream JSON unchanged on success", async () => {
    const downstream = JSON.stringify({
      transactionHash: "0xabc",
      extra: { nested: true },
    });
    const spawn = fakeSpawn({ stdout: `${downstream}\n` });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stdout).toBe(downstream);
  });

  it("injects no Inntris extension fields into a successful response", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xabc" }) });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
    });

    expect(Object.keys(result.json)).toEqual(["transactionHash"]);
    expect(result.stdout).not.toContain("inntris");
    expect(result.stdout).not.toContain("audit");
  });

  it("puts the Inntris audit trail on stderr instead", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xabc" }) });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
    });

    expect(result.stderr).toMatch(/\[inntris\] PASS decision=.+ consumption=.+/u);
    expect(result.stderr).toContain("verify=https://inntris.com/verify/");
  });

  it("keeps stdout valid JSON on every terminal path", async () => {
    const paths = [
      invoke({ operation: "unknown-op" }),
      invoke({ operation: "send-transaction", stdin: "nope" }),
      invoke({
        operation: "send-transaction",
        stdin: JSON.stringify(SEND_TX_INPUT),
        spawn: fakeSpawn(),
        core: fakeCore(() => ({
          status: 403,
          body: {
            verdict: "blocked",
            violation_code: "wallet_chain_not_allowed",
            audit_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            timestamp: "2026-08-20T12:00:00Z",
            detail: "no",
          },
        })),
      }),
    ];
    for (const path of paths) {
      const result = await path;
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });
});
