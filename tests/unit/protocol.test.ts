import { describe, expect, it } from "vitest";

import { run } from "../../src/cli.js";
import { ExitCode } from "../../src/cwp/protocol.js";
import {
  SUPPORTED_CWP_OPERATIONS,
  PASSTHROUGH_OPERATIONS,
  GATED_OPERATIONS,
  callerCeilingMs,
} from "../../src/cwp/operations.js";
import { hashCanonical } from "../../src/cwp/input.js";
import {
  approvingCore,
  baseEnv,
  captureStream,
  DOWNSTREAM_BIN,
  fakeCore,
  fakeSpawn,
  invoke,
  makeStdin,
} from "../helpers.js";

describe("operation surface", () => {
  it("is the union of pass-through and gated operations", () => {
    expect(SUPPORTED_CWP_OPERATIONS).toEqual([...PASSTHROUGH_OPERATIONS, ...GATED_OPERATIONS]);
  });

  it("does not advertise info as a routable capability", () => {
    expect(SUPPORTED_CWP_OPERATIONS).not.toContain("info");
  });

  it("has no operation in both lists", () => {
    const overlap = PASSTHROUGH_OPERATIONS.filter((op) =>
      (GATED_OPERATIONS as readonly string[]).includes(op),
    );
    expect(overlap).toEqual([]);
  });
});

describe("caller ceilings", () => {
  it("matches the cwp-cli timeout table verified at agent-sdk 1e80df8", () => {
    expect(callerCeilingMs("accounts")).toBe(10_000);
    expect(callerCeilingMs("sign-message")).toBe(120_000);
    expect(callerCeilingMs("sign-typed-data")).toBe(120_000);
    expect(callerCeilingMs("sign-transaction")).toBe(120_000);
    expect(callerCeilingMs("send-transaction")).toBe(180_000);
  });

  it("falls through to walletExec's 10s default for unlisted operations", () => {
    for (const operation of ["swidge", "fund", "drain", "grant-session", "generate"]) {
      expect(callerCeilingMs(operation)).toBe(10_000);
    }
  });

  it("does not cap send-transaction at the tight default", () => {
    expect(callerCeilingMs("send-transaction")).toBeGreaterThan(callerCeilingMs("accounts"));
  });
});

describe("protocol errors", () => {
  it("exits 2 UNSUPPORTED_OPERATION for an unknown operation", async () => {
    const spawn = fakeSpawn();
    const result = await invoke({ operation: "teleport-funds", spawn });
    expect(result.exitCode).toBe(ExitCode.UNSUPPORTED);
    expect(result.json["code"]).toBe("UNSUPPORTED_OPERATION");
    expect(spawn.calls).toHaveLength(0);
  });

  it("does not silently pass an unknown mutating operation through", async () => {
    const spawn = fakeSpawn();
    const result = await invoke({
      operation: "sign-everything",
      stdin: JSON.stringify({ account: "0xA" }),
      spawn,
    });
    expect(result.exitCode).toBe(ExitCode.UNSUPPORTED);
    expect(spawn.calls).toHaveLength(0);
  });

  it("exits 2 when no operation is supplied", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const exitCode = await run({
      argv: ["node", "wallet-inntris"],
      env: baseEnv({ INNTRIS_DOWNSTREAM_WALLET_BIN: DOWNSTREAM_BIN }),
      stdin: makeStdin(""),
      stdout,
      stderr,
    });
    expect(exitCode).toBe(ExitCode.UNSUPPORTED);
    expect(JSON.parse(stdout.text())["code"]).toBe("UNSUPPORTED_OPERATION");
  });

  it("rejects invalid JSON on stdin without calling Inntris or the wallet", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({ status: 500, body: {} }));
    const result = await invoke({ operation: "send-transaction", stdin: "{not json", spawn, core });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INVALID_INPUT");
    expect(spawn.calls).toHaveLength(0);
    expect(core.calls).toHaveLength(0);
  });

  it("rejects missing input for a gated operation", async () => {
    const spawn = fakeSpawn();
    const core = fakeCore(() => ({ status: 500, body: {} }));
    const result = await invoke({ operation: "send-transaction", stdin: "", spawn, core });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INVALID_INPUT");
    expect(core.calls).toHaveLength(0);
  });

  it("rejects a non-object JSON body", async () => {
    const spawn = fakeSpawn();
    const result = await invoke({ operation: "send-transaction", stdin: "[1,2,3]", spawn });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INVALID_INPUT");
    expect(spawn.calls).toHaveLength(0);
  });

  it("always writes exactly one JSON object to stdout", async () => {
    const result = await invoke({ operation: "teleport-funds" });
    expect(result.stdout.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
  });
});

describe("downstream failure relaying", () => {
  it("reports malformed downstream JSON as INTERNAL_ERROR", async () => {
    const spawn = fakeSpawn({ stdout: "this is not json", exitCode: 0 });
    const result = await invoke({ operation: "accounts", spawn });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
    expect(String(result.json["error"])).toMatch(/malformed JSON/iu);
  });

  it("propagates a downstream non-zero exit code and its error body verbatim", async () => {
    const body = JSON.stringify({ error: "user said no", code: "USER_REJECTED" });
    const spawn = fakeSpawn({ stdout: body, exitCode: 3 });
    const result = await invoke({ operation: "accounts", spawn });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe(body);
  });

  it("synthesises a matching error when a failing downstream emits no JSON", async () => {
    const spawn = fakeSpawn({ stdout: "", exitCode: 5 });
    const result = await invoke({ operation: "accounts", spawn });
    expect(result.exitCode).toBe(5);
    expect(result.json["code"]).toBe("NOT_CONNECTED");
  });

  it("reports a downstream timeout as exit 4 TIMEOUT", async () => {
    const spawn = fakeSpawn({ delayMs: 5_000, stdout: "{}" });
    const result = await invoke({
      operation: "accounts",
      spawn,
      env: { INNTRIS_DOWNSTREAM_TIMEOUT_MS: "50" },
    });
    expect(result.exitCode).toBe(ExitCode.TIMEOUT);
    expect(result.json["code"]).toBe("TIMEOUT");
  });

  it("reports a missing downstream binary as INTERNAL_ERROR", async () => {
    const result = await invoke({
      operation: "accounts",
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: "/nonexistent/wallet-nope" },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
  });

  it("refuses a relative downstream path", async () => {
    const result = await invoke({
      operation: "accounts",
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: "./wallet-companion" },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/absolute path/iu);
  });
});

describe("operations that legitimately carry no input", () => {
  it("accepts generate with an empty body and still gates it through Inntris", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ address: "0xNEW" }) });
    const core = approvingCore();
    const result = await invoke({ operation: "generate", stdin: "", spawn, core });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(core.calls.map((call) => call.path)).toEqual(["verify", "verify-token"]);
    expect(spawn.calls).toHaveLength(1);
    // The empty body is forwarded as it arrived, not as a synthesised "{}".
    expect(spawn.calls[0]?.stdin).toBe("");
  });

  it("commits the empty body as {} in the signed payload", async () => {
    const core = approvingCore();
    await invoke({
      operation: "generate",
      stdin: "",
      spawn: fakeSpawn({ stdout: "{}" }),
      core,
    });
    const payload = core.calls[0]?.body["payload"] as Record<string, unknown>;
    expect(payload["payload_hash"]).toBe(hashCanonical({}));
    expect(payload["resource_id"]).toBe("wallet:*");
    expect(core.calls[0]?.body["action_type"]).toBe("admin_action");
  });

  it("still rejects an empty body for an operation that needs one", async () => {
    const spawn = fakeSpawn();
    const core = approvingCore();
    const result = await invoke({ operation: "send-transaction", stdin: "", spawn, core });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INVALID_INPUT");
    expect(core.calls).toHaveLength(0);
    expect(spawn.calls).toHaveLength(0);
  });

  it("still rejects malformed JSON for generate", async () => {
    const spawn = fakeSpawn();
    const result = await invoke({ operation: "generate", stdin: "{oops", spawn });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INVALID_INPUT");
    expect(spawn.calls).toHaveLength(0);
  });
});
