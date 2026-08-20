import { describe, expect, it } from "vitest";

import { authoriseAndDelegate } from "../../src/cli.js";
import { assertDelegationIntegrity, hashCanonical, parseCwpInput } from "../../src/cwp/input.js";
import { Deadline, ExitCode, ProtocolError } from "../../src/cwp/protocol.js";
import { silentLogger } from "../../src/observability/logger.js";
import {
  approvingCore,
  baseEnv,
  DOWNSTREAM_BIN,
  fakeSpawn,
  makeStdin,
  SEND_TX_INPUT,
} from "../helpers.js";

/**
 * No request mutation between authorisation and delegation.
 *
 * The mutation is injected through the genuinely-injected Core dependency, at
 * the exact moment the threat model cares about: after `/verify` has approved
 * and `/verify-token` has consumed, before the wallet is spawned. Nothing in
 * the check itself is stubbed — `assertDelegationIntegrity` runs unmodified and
 * the assertion is that no wallet process was created.
 */

function deps(overrides: {
  spawn: ReturnType<typeof fakeSpawn>;
  core: ReturnType<typeof approvingCore>;
}) {
  return {
    argv: ["node", "wallet-inntris", "send-transaction"],
    env: baseEnv({ INNTRIS_DOWNSTREAM_WALLET_BIN: DOWNSTREAM_BIN }),
    stdin: makeStdin(""),
    stdout: process.stdout,
    stderr: process.stderr,
    spawnFn: overrides.spawn.fn,
    fetchImplementation: overrides.core.fetchImplementation,
  };
}

describe("pre-spawn integrity recheck, through the real sequence", () => {
  it("fails closed when the parsed request is mutated after authorisation", async () => {
    const spawn = fakeSpawn();
    const input = parseCwpInput(Buffer.from(JSON.stringify(SEND_TX_INPUT), "utf-8"));

    // Mutate the object the authorisation was derived from, during the
    // consumption call — i.e. after approval, before the wallet spawn.
    const core = approvingCore({
      onConsume: () => {
        (input.parsed as { transaction: { to: string } }).transaction.to =
          "0x9999999999999999999999999999999999999999";
      },
    });

    await expect(
      authoriseAndDelegate(
        deps({ spawn, core }),
        silentLogger,
        "send-transaction",
        Deadline.fromNow(179_000),
        input,
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.GENERAL_ERROR, code: "INTERNAL_ERROR" });

    expect(spawn.calls).toHaveLength(0);
  });

  it("fails closed when the raw stdin buffer is swapped after authorisation", async () => {
    const spawn = fakeSpawn();
    const input = parseCwpInput(Buffer.from(JSON.stringify(SEND_TX_INPUT), "utf-8"));

    const core = approvingCore({
      onConsume: () => {
        input.raw = Buffer.from(
          JSON.stringify({
            ...SEND_TX_INPUT,
            transaction: { ...SEND_TX_INPUT.transaction, to: "0xEVIL" },
          }),
          "utf-8",
        );
      },
    });

    await expect(
      authoriseAndDelegate(
        deps({ spawn, core }),
        silentLogger,
        "send-transaction",
        Deadline.fromNow(179_000),
        input,
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.GENERAL_ERROR, code: "INTERNAL_ERROR" });

    expect(spawn.calls).toHaveLength(0);
  });

  it("fails closed when the buffer is mutated in place after authorisation", async () => {
    const spawn = fakeSpawn();
    const raw = Buffer.from(JSON.stringify(SEND_TX_INPUT), "utf-8");
    const input = parseCwpInput(raw);

    const core = approvingCore({
      onConsume: () => {
        // Flip a byte inside the retained buffer without replacing it.
        const index = input.raw.indexOf(Buffer.from("0xBBBB", "utf-8")) + 2;
        input.raw[index] = "C".charCodeAt(0);
      },
    });

    await expect(
      authoriseAndDelegate(
        deps({ spawn, core }),
        silentLogger,
        "send-transaction",
        Deadline.fromNow(179_000),
        input,
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.GENERAL_ERROR, code: "INTERNAL_ERROR" });

    expect(spawn.calls).toHaveLength(0);
  });

  it("delegates the original bytes verbatim when nothing changed", async () => {
    const spawn = fakeSpawn({ stdout: JSON.stringify({ transactionHash: "0xok" }) });
    const bytes = JSON.stringify(SEND_TX_INPUT);
    const input = parseCwpInput(Buffer.from(bytes, "utf-8"));

    const response = await authoriseAndDelegate(
      deps({ spawn, core: approvingCore() }),
      silentLogger,
      "send-transaction",
      Deadline.fromNow(179_000),
      input,
    );

    expect(response.exitCode).toBe(ExitCode.SUCCESS);
    expect(spawn.calls).toHaveLength(1);
    // Byte-identical: the parsed object was never re-serialised.
    expect(spawn.calls[0]?.stdin).toBe(bytes);
  });
});

describe("assertDelegationIntegrity", () => {
  const raw = Buffer.from(JSON.stringify({ a: 1, b: [2, 3] }), "utf-8");

  it("accepts an untouched request", () => {
    const input = parseCwpInput(raw);
    expect(() => assertDelegationIntegrity(input, hashCanonical(input.parsed))).not.toThrow();
  });

  it("accepts a semantically identical body with different key ordering", () => {
    const reordered = parseCwpInput(Buffer.from(JSON.stringify({ b: [2, 3], a: 1 }), "utf-8"));
    const authorised = hashCanonical({ a: 1, b: [2, 3] });
    expect(() => assertDelegationIntegrity(reordered, authorised)).not.toThrow();
  });

  it("rejects a swapped buffer even when the parsed object is untouched", () => {
    const input = parseCwpInput(raw);
    const authorised = hashCanonical(input.parsed);
    input.raw = Buffer.from(JSON.stringify({ a: 2, b: [2, 3] }), "utf-8");
    expect(() => assertDelegationIntegrity(input, authorised)).toThrow(ProtocolError);
  });

  it("rejects a mutated parsed object even when the buffer is untouched", () => {
    const input = parseCwpInput(raw);
    const authorised = hashCanonical(input.parsed);
    (input.parsed as { a: number }).a = 2;
    expect(() => assertDelegationIntegrity(input, authorised)).toThrow(ProtocolError);
  });

  it("rejects an unparseable buffer", () => {
    const input = parseCwpInput(raw);
    const authorised = hashCanonical(input.parsed);
    input.raw = Buffer.from("{{{", "utf-8");
    expect(() => assertDelegationIntegrity(input, authorised)).toThrow(/no longer parseable/iu);
  });

  it("reports an integrity failure as INTERNAL_ERROR, never as a policy rejection", () => {
    const input = parseCwpInput(raw);
    const authorised = hashCanonical(input.parsed);
    (input.parsed as { a: number }).a = 2;
    try {
      assertDelegationIntegrity(input, authorised);
      expect.unreachable("expected an integrity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).exitCode).toBe(ExitCode.GENERAL_ERROR);
      expect((error as ProtocolError).code).toBe("INTERNAL_ERROR");
      expect((error as ProtocolError).exitCode).not.toBe(ExitCode.REJECTED);
    }
  });
});
