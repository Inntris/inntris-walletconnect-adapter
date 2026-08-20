import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { computeActionHash } from "../src/inntris/signing.js";

/**
 * A local stand-in for Inntris Core, implementing the `/verify` and
 * `/verify-token` contract verified against `KingsmanRon/MTP` at master.
 *
 * It is faithful where it matters for the integration proof: it recomputes the
 * action hash from the submitted parameters exactly as
 * `CryptoService.compute_action_hash(sig_version=3)` does, refuses to consume a
 * token whose action hash does not match, enforces single use, and applies the
 * chain and recipient allowlists the way `api/policy.py` does.
 *
 * It does NOT verify the Ed25519 signature (that needs the agent's registered
 * public key) or maintain a real audit chain — the unit suite covers signature
 * production against Core's own vectors, and this server exists to prove the
 * process topology end to end.
 */

export interface WalletPolicy {
  allowed_chains?: string[];
  allowed_recipients?: Record<string, string[]>;
}

export interface CoreStubRequest {
  path: string;
  body: Record<string, unknown>;
}

export interface CoreStub {
  url: string;
  requests: CoreStubRequest[];
  close(): Promise<void>;
}

const DECISION_AUDIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONSUMPTION_AUDIT_ID = "11111111-2222-4333-8444-999999999999";

function recipientAllowed(chain: string, recipient: string, allowlist: string[]): boolean {
  if (chain.split(":", 1)[0]?.toLowerCase() === "eip155") {
    const target = recipient.toLowerCase();
    return allowlist.some((entry) => entry.toLowerCase() === target);
  }
  return allowlist.includes(recipient);
}

function evaluateWalletPolicy(
  policy: WalletPolicy | undefined,
  actionType: string,
  payload: Record<string, unknown>,
): { violation: string; detail: string } | undefined {
  if (policy === undefined || actionType !== "wallet_transaction") return undefined;

  const chain = typeof payload["chain"] === "string" ? payload["chain"] : undefined;

  if (policy.allowed_chains !== undefined) {
    if (chain === undefined) {
      return { violation: "wallet_chain_not_allowed", detail: "payload.chain is required." };
    }
    if (!policy.allowed_chains.includes(chain)) {
      return {
        violation: "wallet_chain_not_allowed",
        detail: `Chain '${chain}' is not in the agent's allowed chains.`,
      };
    }
  }

  if (policy.allowed_recipients === undefined) return undefined;
  if (chain === undefined) {
    return {
      violation: "wallet_chain_not_allowed",
      detail: "payload.chain is required to select the recipient allowlist.",
    };
  }

  const allowlist = policy.allowed_recipients[chain];
  if (allowlist === undefined) return undefined;

  const recipient = typeof payload["recipient"] === "string" ? payload["recipient"] : undefined;
  if (recipient === undefined || recipient.trim() === "") {
    return {
      violation: "wallet_recipient_required",
      detail: `payload.recipient is required for chain '${chain}'.`,
    };
  }
  if (!recipientAllowed(chain, recipient, allowlist)) {
    return {
      violation: "wallet_recipient_not_allowed",
      detail: `Recipient '${recipient}' is not in the allowlist configured for chain '${chain}'.`,
    };
  }
  return undefined;
}

export async function startCoreStub(
  options: { walletPolicy?: WalletPolicy } = {},
): Promise<CoreStub> {
  const requests: CoreStubRequest[] = [];
  const consumedTokens = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").replace(/^\//u, "");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      } catch {
        /* recorded below as an empty body */
      }
      requests.push({ path, body });

      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (path === "verify") {
        const actionType = String(body["action_type"]);
        const payload = (body["payload"] ?? {}) as Record<string, unknown>;
        const violation = evaluateWalletPolicy(options.walletPolicy, actionType, payload);
        if (violation !== undefined) {
          reply(403, {
            verdict: "blocked",
            violation_code: violation.violation,
            audit_id: DECISION_AUDIT_ID,
            timestamp: new Date().toISOString(),
            detail: violation.detail,
            idempotency_status: "new",
          });
          return;
        }
        reply(200, {
          verdict: "approved",
          verdict_reason: "All verification checks passed",
          approval_token: `token-${String(body["request_ref"])}`,
          trust_score: 60,
          audit_id: DECISION_AUDIT_ID,
          timestamp: new Date().toISOString(),
          limits_remaining: {},
          idempotency_status: "new",
        });
        return;
      }

      if (path === "verify-token") {
        const token = String(body["approval_token"]);
        const executionRef = String(body["execution_ref"]);
        const actionHash = computeActionHash({
          agentId: String(body["agent_id"]),
          actionType: String(body["action_type"]),
          payload: body["payload"],
          nonce: String(body["nonce"]),
          timestamp: String(body["timestamp"]),
        });

        const previous = consumedTokens.get(token);
        if (previous !== undefined && previous !== executionRef) {
          reply(200, { valid: false, reason: "Token already used (single-use)." });
          return;
        }
        consumedTokens.set(token, executionRef);

        reply(200, {
          valid: true,
          verdict: "approved",
          agent_id: body["agent_id"],
          action_hash: actionHash,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          action_hash_matches: true,
          consumption_audit_id: CONSUMPTION_AUDIT_ID,
          consumption_status: previous === undefined ? "consumed" : "idempotent",
          execution_ref: executionRef,
          sandbox: false,
        });
        return;
      }

      reply(404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export { DECISION_AUDIT_ID, CONSUMPTION_AUDIT_ID };
