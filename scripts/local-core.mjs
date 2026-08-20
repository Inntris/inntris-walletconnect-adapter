#!/usr/bin/env node
/**
 * A local stand-in for Inntris Core, for running the demo without live
 * credentials.
 *
 * It implements the `/verify` and `/verify-token` contract verified against
 * KingsmanRon/MTP at master, and reuses the adapter's own action-hash
 * computation so the exact-action binding the demo shows is genuinely
 * recomputed rather than echoed.
 *
 * It does NOT verify Ed25519 signatures, keep an audit chain, or anchor
 * receipts. Point INNTRIS_CORE_URL at a real Inntris Core for that; the audit
 * ids printed here are placeholders.
 *
 * Usage: node scripts/local-core.mjs <port> <wallet-policy-json>
 */
import { createServer } from "node:http";

import { computeActionHash } from "../dist/inntris/signing.js";

const port = Number(process.argv[2] ?? 8787);
const walletPolicy = JSON.parse(process.argv[3] ?? "{}");

const DECISION_AUDIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONSUMPTION_AUDIT_ID = "11111111-2222-4333-8444-999999999999";
const consumed = new Map();

function recipientAllowed(chain, recipient, allowlist) {
  if (chain.split(":")[0].toLowerCase() === "eip155") {
    return allowlist.some((entry) => entry.toLowerCase() === recipient.toLowerCase());
  }
  return allowlist.includes(recipient);
}

function evaluate(actionType, payload) {
  if (actionType !== "wallet_transaction") return undefined;
  const chain = typeof payload.chain === "string" ? payload.chain : undefined;

  if (Array.isArray(walletPolicy.allowed_chains)) {
    if (!chain) {
      return { code: "wallet_chain_not_allowed", detail: "payload.chain is required." };
    }
    if (!walletPolicy.allowed_chains.includes(chain)) {
      return {
        code: "wallet_chain_not_allowed",
        detail: `Chain '${chain}' is not in the agent's allowed chains.`,
      };
    }
  }

  const recipients = walletPolicy.allowed_recipients;
  if (!recipients || typeof recipients !== "object") return undefined;
  if (!chain) {
    return {
      code: "wallet_chain_not_allowed",
      detail: "payload.chain is required to select the recipient allowlist.",
    };
  }
  const allowlist = recipients[chain];
  if (!Array.isArray(allowlist)) return undefined;

  const recipient = typeof payload.recipient === "string" ? payload.recipient : undefined;
  if (!recipient || recipient.trim() === "") {
    return {
      code: "wallet_recipient_required",
      detail: `payload.recipient is required for chain '${chain}'.`,
    };
  }
  if (!recipientAllowed(chain, recipient, allowlist)) {
    return {
      code: "wallet_recipient_not_allowed",
      detail: `Recipient '${recipient}' is not in the allowlist configured for chain '${chain}'.`,
    };
  }
  return undefined;
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const path = (req.url ?? "").replace(/^\//, "");
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      /* empty body is recorded as {} */
    }
    const reply = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "verify") {
      const violation = evaluate(body.action_type, body.payload ?? {});
      process.stderr.write(
        `[local-core] /verify action=${body.action_type} verdict=${violation ? "BLOCKED" : "APPROVED"}\n`,
      );
      if (violation) {
        reply(403, {
          verdict: "blocked",
          violation_code: violation.code,
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
        approval_token: `token-${body.request_ref}`,
        trust_score: 60,
        audit_id: DECISION_AUDIT_ID,
        timestamp: new Date().toISOString(),
        limits_remaining: {},
        idempotency_status: "new",
      });
      return;
    }

    if (path === "verify-token") {
      const token = body.approval_token;
      const executionRef = body.execution_ref;
      const previous = consumed.get(token);
      if (previous !== undefined && previous !== executionRef) {
        process.stderr.write("[local-core] /verify-token REJECTED (single-use)\n");
        reply(200, { valid: false, reason: "Token already used (single-use)." });
        return;
      }
      consumed.set(token, executionRef);
      process.stderr.write(`[local-core] /verify-token consumed execution_ref=${executionRef}\n`);
      reply(200, {
        valid: true,
        verdict: "approved",
        agent_id: body.agent_id,
        action_hash: computeActionHash({
          agentId: body.agent_id,
          actionType: body.action_type,
          payload: body.payload,
          nonce: body.nonce,
          timestamp: body.timestamp,
        }),
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
}).listen(port, "127.0.0.1", () => {
  process.stderr.write(`[local-core] listening on http://127.0.0.1:${port}\n`);
});
