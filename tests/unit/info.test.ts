import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCode } from "../../src/cwp/protocol.js";
import { SUPPORTED_CWP_OPERATIONS } from "../../src/cwp/operations.js";
import { intersectCapabilities } from "../../src/downstream/info-cache.js";
import { fakeCore, fakeSpawn, invoke } from "../helpers.js";

/**
 * The discovery path.
 *
 * `info` runs inside WalletConnect's 3 s budget, spawning a second Node
 * process from inside the first, and must never depend on Inntris Core.
 */

let cacheDir: string;
let cachePath: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "inntris-info-"));
  cachePath = join(cacheDir, "downstream-info.json");
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

const DOWNSTREAM_INFO = {
  name: "downstream-stub",
  version: "0.0.1",
  rdns: "test.downstream.stub",
  capabilities: [
    "accounts",
    "balance",
    "sign-message",
    "send-transaction",
    // Not in SUPPORTED_CWP_OPERATIONS — must not be advertised.
    "teleport",
  ],
  chains: ["eip155:8453", "eip155:1"],
};

function infoSpawn(overrides: Parameters<typeof fakeSpawn>[0] = {}) {
  return fakeSpawn({ stdout: JSON.stringify(DOWNSTREAM_INFO), exitCode: 0, ...overrides });
}

describe("intersectCapabilities", () => {
  it("keeps only operations the shim can route", () => {
    expect(intersectCapabilities(["accounts", "teleport", "send-transaction"])).toEqual([
      "accounts",
      "send-transaction",
    ]);
  });

  it("never returns anything outside SUPPORTED_CWP_OPERATIONS", () => {
    const result = intersectCapabilities([...SUPPORTED_CWP_OPERATIONS, "nonsense", "info"]);
    for (const capability of result) {
      expect(SUPPORTED_CWP_OPERATIONS).toContain(capability);
    }
    expect(result).not.toContain("info");
  });

  it("drops downstream capabilities the shim does not implement", () => {
    expect(intersectCapabilities(["teleport"])).toEqual([]);
  });
});

describe("wallet-inntris info", () => {
  it("returns the Inntris descriptor with the intersected capability set", async () => {
    const spawn = infoSpawn();
    const result = await invoke({
      operation: "info",
      spawn,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.json["name"]).toBe("inntris");
    expect(result.json["rdns"]).toBe("com.inntris.wallet");
    expect(result.json["version"]).toBe("0.1.0");
    expect(result.json["capabilities"]).toEqual([
      "accounts",
      "balance",
      "sign-message",
      "send-transaction",
    ]);
  });

  it("does not advertise a downstream capability absent from SUPPORTED_CWP_OPERATIONS", async () => {
    const result = await invoke({
      operation: "info",
      spawn: infoSpawn(),
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(result.json["capabilities"]).not.toContain("teleport");
  });

  it("passes chains through unmodified and does not intersect them", async () => {
    const result = await invoke({
      operation: "info",
      spawn: infoSpawn(),
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(result.json["chains"]).toEqual(["eip155:8453", "eip155:1"]);
  });

  it("never calls Inntris Core", async () => {
    const core = fakeCore(() => {
      throw new Error("info must not depend on Core availability");
    });
    const result = await invoke({
      operation: "info",
      spawn: infoSpawn(),
      core,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(core.calls).toHaveLength(0);
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
  });

  it("works with no Inntris Core configuration present at all", async () => {
    const result = await invoke({
      operation: "info",
      spawn: infoSpawn(),
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_CORE_URL: undefined,
        INNTRIS_AGENT_ID: undefined,
        INNTRIS_PRIVATE_KEY_B64: undefined,
      },
    });
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.json["name"]).toBe("inntris");
  });
});

describe("info fallback", () => {
  const fallback = JSON.stringify({
    capabilities: ["accounts", "send-transaction", "teleport"],
    chains: ["eip155:8453"],
  });

  it("returns the static fallback when downstream info is unreachable", async () => {
    const spawn = fakeSpawn({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
    const result = await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_DOWNSTREAM_INFO_FALLBACK: fallback,
      },
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.json["capabilities"]).toEqual(["accounts", "send-transaction"]);
  });

  it("applies the same intersection on the fallback path", async () => {
    const spawn = fakeSpawn({ stdout: "garbage", exitCode: 0 });
    const result = await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_DOWNSTREAM_INFO_FALLBACK: fallback,
      },
    });
    expect(result.json["capabilities"]).not.toContain("teleport");
  });

  it("falls back when the downstream exits non-zero", async () => {
    const spawn = fakeSpawn({ stdout: "{}", exitCode: 1 });
    const result = await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_DOWNSTREAM_INFO_FALLBACK: fallback,
      },
    });
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
  });

  it("completes within the 1500 ms cap against a deliberately slow downstream", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify(DOWNSTREAM_INFO), delayMs: 10_000 });
    const started = performance.now();
    const result = await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_DOWNSTREAM_INFO_FALLBACK: fallback,
      },
    });
    const elapsed = performance.now() - started;

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(elapsed).toBeLessThan(2_500);
    expect(result.json["capabilities"]).toEqual(["accounts", "send-transaction"]);
  });

  it("exits 1 INTERNAL_ERROR naming the provider when nothing can be resolved", async () => {
    const spawn = fakeSpawn({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
    const result = await invoke({
      operation: "info",
      spawn,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
    expect(String(result.json["error"])).toContain("companion");
  });

  it("exits 1 INTERNAL_ERROR when the intersection is empty", async () => {
    const spawn = fakeSpawn({
      stdout: JSON.stringify({ ...DOWNSTREAM_INFO, capabilities: ["teleport", "warp"] }),
    });
    const result = await invoke({
      operation: "info",
      spawn,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.json["code"]).toBe("INTERNAL_ERROR");
    expect(String(result.json["error"])).toContain("companion");
  });
});

describe("info cache", () => {
  it("serves a warm cache without respawning the downstream", async () => {
    const first = infoSpawn();
    await invoke({
      operation: "info",
      spawn: first,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(first.calls).toHaveLength(1);

    const second = infoSpawn();
    const result = await invoke({
      operation: "info",
      spawn: second,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(second.calls).toHaveLength(0);
    expect(result.json["capabilities"]).toEqual([
      "accounts",
      "balance",
      "sign-message",
      "send-transaction",
    ]);
  });

  it("does not serve a descriptor written by an earlier adapter version", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        bin_path: new URL("../fixtures/wallet-downstream-stub", import.meta.url).pathname,
        bin_mtime_ms: 0,
        adapter_version: "0.0.1-old",
        capabilities: ["teleport"],
        chains: ["eip155:999"],
      }),
    );

    const spawn = infoSpawn();
    const result = await invoke({
      operation: "info",
      spawn,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });

    // The stale entry is ignored and the downstream is re-queried.
    expect(spawn.calls).toHaveLength(1);
    expect(result.json["capabilities"]).not.toContain("teleport");
    expect(result.json["chains"]).toEqual(["eip155:8453", "eip155:1"]);
  });

  it("does not serve a descriptor keyed to a different binary", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        bin_path: "/some/other/wallet-thing",
        bin_mtime_ms: 0,
        adapter_version: "0.1.0",
        capabilities: ["teleport"],
        chains: [],
      }),
    );
    const spawn = infoSpawn();
    await invoke({
      operation: "info",
      spawn,
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    expect(spawn.calls).toHaveLength(1);
  });

  it("writes the cache with owner-only permissions", async () => {
    await invoke({
      operation: "info",
      spawn: infoSpawn(),
      env: { INNTRIS_INFO_CACHE_PATH: cachePath },
    });
    const { statSync } = await import("node:fs");
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("does not cache a fallback descriptor", async () => {
    const spawn = fakeSpawn({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) });
    await invoke({
      operation: "info",
      spawn,
      env: {
        INNTRIS_INFO_CACHE_PATH: cachePath,
        INNTRIS_DOWNSTREAM_INFO_FALLBACK: JSON.stringify({
          capabilities: ["accounts"],
          chains: [],
        }),
      },
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(cachePath)).toBe(false);
  });
});
