import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startCoreStub, type CoreStub, type WalletPolicy } from "../core-stub.js";
import { runWallet, type WalletRun } from "./harness.js";

/**
 * The real WalletConnect CWP path.
 *
 * Nothing here is simulated on the WalletConnect side: this runs the published
 * `@walletconnect/cli-sdk@0.8.5` binaries — the same version as the pinned
 * agent-sdk commit 1e80df8 — against a PATH that exposes `wallet-inntris` and
 * deliberately does not expose the downstream provider.
 *
 *     wallet (WalletConnect CLI)
 *       -> CWP discovery
 *       -> wallet-inntris
 *       -> Inntris /verify + /verify-token
 *       -> downstream wallet
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ADAPTER_ENTRY = join(REPO_ROOT, "dist", "cli.js");
const DOWNSTREAM_STUB = join(REPO_ROOT, "tests", "fixtures", "wallet-recording-stub");

const DEMO_CHAIN = "eip155:8453";
const APPROVED_RECIPIENT = "0x1111111111111111111111111111111111111111";
const BLOCKED_RECIPIENT = "0x9999999999999999999999999999999999999999";
const ACCOUNT = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const SEED_B64 = Buffer.alloc(32, 7).toString("base64");

const DEMO_POLICY: WalletPolicy = {
  allowed_chains: [DEMO_CHAIN],
  allowed_recipients: { [DEMO_CHAIN]: [APPROVED_RECIPIENT] },
};

function sendTxInput(to: string): string {
  return JSON.stringify({
    account: ACCOUNT,
    chain: DEMO_CHAIN,
    transaction: { to, value: "0x2386f26fc10000", data: "0x" },
  });
}

let workDir: string;
let binDir: string;
let core: CoreStub | undefined;

beforeAll(() => {
  if (!existsSync(ADAPTER_ENTRY)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  }
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "inntris-cwp-"));
  binDir = join(workDir, "bin");
  mkdirSync(binDir);
  // The governed PATH exposes the shim, and only the shim.
  symlinkSync(ADAPTER_ENTRY, join(binDir, "wallet-inntris"));
});

afterEach(async () => {
  await core?.close();
  core = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

afterAll(() => {
  /* nothing global to tear down */
});

function walletEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    // node must be reachable for the `#!/usr/bin/env node` shebang, but no
    // other wallet-* provider may be.
    PATH: `${binDir}:${dirname(process.execPath)}`,
    HOME: workDir,
    INNTRIS_CORE_URL: core?.url ?? "http://127.0.0.1:1",
    INNTRIS_AGENT_ID: AGENT_ID,
    INNTRIS_PRIVATE_KEY_B64: SEED_B64,
    INNTRIS_DOWNSTREAM_WALLET_BIN: DOWNSTREAM_STUB,
    INNTRIS_DOWNSTREAM_PROVIDER_NAME: "recording-stub",
    INNTRIS_INFO_CACHE_PATH: join(workDir, "downstream-info.json"),
    DOWNSTREAM_MARKER_FILE: join(workDir, "downstream-invocations.jsonl"),
    ...overrides,
  };
}

/** Downstream invocations recorded by the stub. Empty means it never ran. */
function downstreamInvocations(): unknown[] {
  const marker = join(workDir, "downstream-invocations.jsonl");
  if (!existsSync(marker)) return [];
  return readFileSync(marker, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function walletBinariesOnPath(pathEnv: string): string[] {
  const found: string[] = [];
  for (const dir of pathEnv.split(":")) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    found.push(...entries.filter((entry) => entry.startsWith("wallet-")));
  }
  return found;
}

describe("CWP discovery through the real WalletConnect CLI", () => {
  it("exposes wallet-inntris and nothing else as a provider on the governed PATH", () => {
    const env = walletEnv();
    expect(walletBinariesOnPath(env["PATH"] as string)).toEqual(["wallet-inntris"]);
  });

  it("discovers wallet-inntris with a cold cache, inside the 3s discovery budget", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    expect(existsSync(join(workDir, "downstream-info.json"))).toBe(false);

    const started = performance.now();
    const run: WalletRun = await runWallet(["list"], { env: walletEnv() });
    const elapsed = performance.now() - started;

    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      providers: Array<{
        name: string;
        capabilities?: string[];
        chains?: string[];
        error?: string;
      }>;
    };
    const inntris = parsed.providers.find((provider) => provider.name === "inntris");

    expect(inntris).toBeDefined();
    expect(inntris?.error).toBeUndefined();
    // Discovery would record `info: null` for a provider that failed to answer.
    expect(inntris?.capabilities).toContain("send-transaction");
    expect(elapsed).toBeLessThan(3_000);
  });

  it("advertises only capabilities the shim can route", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    const run = await runWallet(["list"], { env: walletEnv() });
    const parsed = JSON.parse(run.stdout) as {
      providers: Array<{ name: string; capabilities?: string[]; chains?: string[] }>;
    };
    const inntris = parsed.providers.find((provider) => provider.name === "inntris");

    expect(inntris?.capabilities).toEqual([
      "accounts",
      "balance",
      "sign-message",
      "sign-typed-data",
      "sign-transaction",
      "send-transaction",
    ]);
    // Chains pass through unmodified: not narrowed to the policy's chain.
    expect(inntris?.chains).toEqual(["eip155:8453", "eip155:1"]);
  });

  it("resolves discovery from a warm cache without respawning the downstream", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    await runWallet(["list"], { env: walletEnv() });
    expect(existsSync(join(workDir, "downstream-info.json"))).toBe(true);

    const started = performance.now();
    const run = await runWallet(["list"], { env: walletEnv() });
    expect(run.exitCode).toBe(0);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("Scenario 1 — PASS: authorised recipient", () => {
  it("routes WalletConnect -> wallet-inntris -> Inntris -> downstream wallet", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });

    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: sendTxInput(APPROVED_RECIPIENT),
    });

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ transactionHash: "0xDOWNSTREAMTXHASH" });

    // Inntris was consulted, in the mandated order.
    expect(core.requests.map((request) => request.path)).toEqual(["verify", "verify-token"]);
    expect(core.requests[1]?.body["consume"]).toBe(true);

    // And the wallet really ran, exactly once, with the original bytes.
    const invocations = downstreamInvocations() as Array<{ operation: string; stdin: string }>;
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.operation).toBe("send-transaction");
    expect(invocations[0]?.stdin).toBe(sendTxInput(APPROVED_RECIPIENT));
  });

  it("signs a wallet_transaction carrying the rail and trust-boundary identifiers", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: sendTxInput(APPROVED_RECIPIENT),
    });

    const verify = core.requests[0];
    expect(verify?.body["action_type"]).toBe("wallet_transaction");
    expect(verify?.body["sig_version"]).toBe(3);

    const payload = verify?.body["payload"] as Record<string, unknown>;
    expect(payload["platform"]).toBe("walletconnect-cwp");
    expect(payload["rail"]).toBe("walletconnect_cwp");
    expect(payload["trust_level"]).toBe("external_cwp_provider");
    expect(payload["recipient"]).toBe(APPROVED_RECIPIENT);
    expect(payload["chain"]).toBe(DEMO_CHAIN);
  });

  it("keeps the CWP response free of Inntris extension fields", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: sendTxInput(APPROVED_RECIPIENT),
    });
    expect(Object.keys(JSON.parse(run.stdout))).toEqual(["transactionHash"]);
  });

  it("never exports the Inntris signing key to the wallet process", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: sendTxInput(APPROVED_RECIPIENT),
    });
    const invocations = downstreamInvocations();
    expect(JSON.stringify(invocations)).not.toContain(SEED_B64);
  });
});

describe("Scenario 2 — BLOCK: unauthorised recipient", () => {
  it("blocks at Inntris and never invokes the wallet", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });

    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: sendTxInput(BLOCKED_RECIPIENT),
    });

    // The WalletConnect CLI surfaces the provider's exit code.
    expect(run.exitCode).toBe(3);
    // The single most important assertion in this file.
    expect(downstreamInvocations()).toHaveLength(0);
    expect(existsSync(join(workDir, "downstream-invocations.jsonl"))).toBe(false);

    // Only /verify was reached: there is no approval to consume.
    expect(core.requests.map((request) => request.path)).toEqual(["verify"]);
  });

  it("differs from the PASS run only in transaction.to", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    const pass = sendTxInput(APPROVED_RECIPIENT);
    const block = sendTxInput(BLOCKED_RECIPIENT);
    expect(pass.replace(APPROVED_RECIPIENT, "<TO>")).toBe(block.replace(BLOCKED_RECIPIENT, "<TO>"));

    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: block,
    });
    expect(run.exitCode).toBe(3);
    expect(downstreamInvocations()).toHaveLength(0);
  });

  it("blocks a chain outside the allowlist", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv(),
      stdin: JSON.stringify({
        account: ACCOUNT,
        chain: "eip155:1",
        transaction: { to: APPROVED_RECIPIENT, value: "0x1", data: "0x" },
      }),
    });
    expect(run.exitCode).toBe(3);
    expect(downstreamInvocations()).toHaveLength(0);
  });
});

describe("fail-closed behaviour through the real CLI", () => {
  it("does not invoke the wallet when Inntris Core is unreachable", async () => {
    // No Core stub started: INNTRIS_CORE_URL points at a closed port.
    const run = await runWallet(["send-transaction", "--wallet", "inntris"], {
      env: walletEnv({ INNTRIS_CORE_URL: "http://127.0.0.1:1" }),
      stdin: sendTxInput(APPROVED_RECIPIENT),
    });

    expect(run.exitCode).toBe(1);
    expect(downstreamInvocations()).toHaveLength(0);
  });

  it("passes accounts straight through without consulting Inntris", async () => {
    core = await startCoreStub({ walletPolicy: DEMO_POLICY });
    const run = await runWallet(["accounts", "--wallet", "inntris"], { env: walletEnv() });

    expect(run.exitCode).toBe(0);
    expect(core.requests).toHaveLength(0);
    expect(downstreamInvocations()).toHaveLength(1);
  });
});
