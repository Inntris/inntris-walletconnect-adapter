import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { childEnvironment } from "../../src/downstream/delegate.js";
import { ExitCode } from "../../src/cwp/protocol.js";
import { approvingCore, fakeSpawn, invoke, SEND_TX_INPUT, TEST_SEED_B64 } from "../helpers.js";

/** Downstream process hardening: secrets, argv, and PATH bypass protection. */

let pathDir: string;

beforeEach(() => {
  pathDir = mkdtempSync(join(tmpdir(), "inntris-path-"));
});

afterEach(() => {
  rmSync(pathDir, { recursive: true, force: true });
});

describe("child environment", () => {
  it("strips the Inntris signing key", () => {
    const result = childEnvironment({
      PATH: "/usr/bin",
      INNTRIS_PRIVATE_KEY_B64: TEST_SEED_B64,
    });
    expect(result["INNTRIS_PRIVATE_KEY_B64"]).toBeUndefined();
    expect(result["PATH"]).toBe("/usr/bin");
  });

  it("strips the whole INNTRIS_ namespace, not just the key", () => {
    const result = childEnvironment({
      INNTRIS_PRIVATE_KEY_B64: "secret",
      INNTRIS_CORE_URL: "https://core.example",
      INNTRIS_AGENT_ID: "agent",
      HOME: "/home/user",
    });
    expect(Object.keys(result)).toEqual(["HOME"]);
  });

  it("passes unrelated environment through", () => {
    const result = childEnvironment({ HOME: "/root", LANG: "C" });
    expect(result).toEqual({ HOME: "/root", LANG: "C" });
  });
});

describe("secrets never reach the wallet process", () => {
  it("removes INNTRIS_PRIVATE_KEY_B64 from the spawned environment", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xok" }) });
    await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
    });

    const childEnv = spawn.calls[0]?.env ?? {};
    expect(childEnv["INNTRIS_PRIVATE_KEY_B64"]).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain(TEST_SEED_B64);
  });

  it("removes them on the pass-through path too", async () => {
    const spawn = fakeSpawn({ stdout: "{}" });
    await invoke({ operation: "accounts", spawn });
    expect(spawn.calls[0]?.env["INNTRIS_PRIVATE_KEY_B64"]).toBeUndefined();
  });
});

describe("bypass protection", () => {
  function makeDiscoverableDownstream(): string {
    const binPath = join(pathDir, "wallet-companion");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    return binPath;
  }

  it("refuses to delegate when the downstream is discoverable on PATH", async () => {
    const binPath = makeDiscoverableDownstream();
    const spawn = fakeSpawn();
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: binPath, PATH: pathDir },
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/discoverable on PATH/iu);
    expect(spawn.calls).toHaveLength(0);
  });

  it("blocks before any Inntris call, so a misconfiguration costs nothing", async () => {
    const binPath = makeDiscoverableDownstream();
    const core = approvingCore();
    await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn: fakeSpawn(),
      core,
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: binPath, PATH: pathDir },
    });
    expect(core.calls).toHaveLength(0);
  });

  it("also refuses on the pass-through path", async () => {
    const binPath = makeDiscoverableDownstream();
    const spawn = fakeSpawn();
    const result = await invoke({
      operation: "accounts",
      spawn,
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: binPath, PATH: pathDir },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(spawn.calls).toHaveLength(0);
  });

  it("downgrades to a warning with the explicit development override", async () => {
    const binPath = makeDiscoverableDownstream();
    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xok" }) });
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn,
      core: approvingCore(),
      env: {
        INNTRIS_DOWNSTREAM_WALLET_BIN: binPath,
        PATH: pathDir,
        INNTRIS_ALLOW_DISCOVERABLE_DOWNSTREAM: "true",
      },
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toMatch(/WARN .*discoverable on PATH/u);
    expect(spawn.calls).toHaveLength(1);
  });

  it("warns rather than failing on the info path, so the provider stays visible", async () => {
    const binPath = makeDiscoverableDownstream();
    const spawn = fakeSpawn({
      stdout: JSON.stringify({
        name: "d",
        version: "1",
        capabilities: ["accounts"],
        chains: ["eip155:8453"],
      }),
    });
    const result = await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_DOWNSTREAM_WALLET_BIN: binPath,
        PATH: pathDir,
        INNTRIS_INFO_CACHE_PATH: join(pathDir, "cache.json"),
      },
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.stderr).toMatch(/WARN .*discoverable on PATH/u);
  });

  it("refuses a downstream path that points back at wallet-inntris", async () => {
    const binPath = join(pathDir, "wallet-inntris");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    const result = await invoke({
      operation: "accounts",
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: binPath, PATH: "/nonexistent" },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/refusing to delegate to self/iu);
  });

  it("refuses a non-executable downstream binary", async () => {
    const binPath = join(pathDir, "wallet-notexec");
    writeFileSync(binPath, "nope");
    chmodSync(binPath, 0o644);
    const result = await invoke({
      operation: "accounts",
      env: { INNTRIS_DOWNSTREAM_WALLET_BIN: binPath, PATH: "/nonexistent" },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/not executable/iu);
  });
});

describe("configuration validation", () => {
  it("rejects a private key that is not a 32-byte seed", async () => {
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn: fakeSpawn(),
      env: { INNTRIS_PRIVATE_KEY_B64: Buffer.alloc(8).toString("base64") },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(String(result.json["error"])).toMatch(/32-byte Ed25519 seed/u);
  });

  it("rejects a non-http Core URL", async () => {
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn: fakeSpawn(),
      env: { INNTRIS_CORE_URL: "ftp://core.example" },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
  });

  it("rejects a missing agent id before any network call", async () => {
    const core = approvingCore();
    const result = await invoke({
      operation: "send-transaction",
      stdin: JSON.stringify(SEND_TX_INPUT),
      spawn: fakeSpawn(),
      core,
      env: { INNTRIS_AGENT_ID: undefined },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(core.calls).toHaveLength(0);
  });
});
