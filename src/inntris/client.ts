import type { Deadline } from "../cwp/protocol.js";
import { ProtocolError } from "../cwp/protocol.js";
import { blockMessageFor } from "../policy/wallet-policy.js";
import type { BuiltSignedAction } from "./signing.js";
import {
  VerifyApprovedResponseSchema,
  VerifyDeniedResponseSchema,
  VerifyTokenResponseSchema,
} from "./schemas.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface CoreClientOptions {
  coreUrl: URL;
  agentId: string;
  /** Per-call cap. Fixed; it does not grow with the invocation deadline. */
  coreTimeoutMs: number;
  fetchImplementation?: FetchLike;
}

/** Inntris authorised the exact action; the approval has been consumed. */
export interface CorePassResult {
  outcome: "PASS";
  decisionAuditId: string;
  consumptionAuditId: string;
  consumptionStatus: "consumed" | "idempotent";
  actionHash: string;
  trustScore: number;
}

/** Inntris denied the action. The downstream wallet must not run. */
export interface CoreBlockResult {
  outcome: "BLOCK";
  verdict: "blocked" | "rate_limited";
  violationCode: string;
  detail: string;
  decisionAuditId: string;
  /** Protocol-shaped message for stdout. */
  message: string;
}

export type CoreResult = CorePassResult | CoreBlockResult;

interface HttpResult {
  status: number;
  body: unknown;
}

function endpoint(base: URL, pathname: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${pathname}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The Inntris authority client.
 *
 * It performs exactly two calls, in a fixed order, and every failure mode
 * short-circuits before delegation:
 *
 *     POST /verify  →  POST /verify-token (consume=true)  →  caller may spawn
 *
 * It maintains no spend ledger. Reservation and consumption are Core's, and
 * stay Core's (security invariant 17).
 */
export class InntrisCoreClient {
  readonly #fetch: FetchLike;

  constructor(private readonly options: CoreClientOptions) {
    this.#fetch = options.fetchImplementation ?? ((input, init) => fetch(input, init));
  }

  async #post(pathname: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
    let response: Response;
    try {
      response = await this.#fetch(endpoint(this.options.coreUrl, pathname), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: unknown }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw ProtocolError.timeout(`Inntris Core request to /${pathname} timed out`);
      }
      throw ProtocolError.internal(`Inntris Core is unavailable (/${pathname})`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw ProtocolError.internal(`Inntris Core returned a non-JSON response from /${pathname}`);
    }
    return { status: response.status, body: parsed };
  }

  /**
   * Authorise and consume, in that order.
   *
   * Returns BLOCK only for an authenticated policy denial. Every other failure
   * — Core unreachable, malformed response, token consumption refused, action
   * hash mismatch, sandbox token — throws, because those are internal authority
   * failures rather than a decision, and they must not be reported to the
   * caller as "the user rejected this".
   */
  async authoriseAndConsume(params: {
    signed: BuiltSignedAction;
    executionRef: string;
    deadline: Deadline;
  }): Promise<CoreResult> {
    const { signed, executionRef, deadline } = params;

    const verifyTimeout = deadline.reserve("Inntris /verify", 1, this.options.coreTimeoutMs);
    const verification = await this.#post("verify", signed.request, verifyTimeout);

    if (verification.status === 403 || verification.status === 429) {
      const denied = VerifyDeniedResponseSchema.safeParse(verification.body);
      if (!denied.success) {
        throw ProtocolError.internal("Inntris Core returned a malformed denial");
      }
      return {
        outcome: "BLOCK",
        verdict: denied.data.verdict,
        violationCode: denied.data.violation_code,
        detail: denied.data.detail,
        decisionAuditId: denied.data.audit_id,
        message: blockMessageFor(denied.data.violation_code, denied.data.detail),
      };
    }

    if (verification.status !== 200) {
      throw ProtocolError.internal(
        `Inntris Core verification failed with HTTP ${verification.status}`,
      );
    }

    const approved = VerifyApprovedResponseSchema.safeParse(verification.body);
    if (!approved.success) {
      throw ProtocolError.internal("Inntris Core returned a malformed approval");
    }

    // The consumption request restates the *same* signed action inputs. Core
    // recomputes the action hash from them and refuses if it does not match the
    // hash the token authorises, which is what binds this execution to this
    // approval rather than to some other approved action.
    const consumeTimeout = deadline.reserve(
      "Inntris /verify-token",
      1,
      this.options.coreTimeoutMs,
    );
    const consumption = await this.#post(
      "verify-token",
      {
        approval_token: approved.data.approval_token,
        agent_id: signed.request.agent_id,
        action_type: signed.request.action_type,
        payload: signed.request.payload,
        nonce: signed.request.nonce,
        timestamp: signed.request.timestamp,
        sig_version: signed.request.sig_version,
        consume: true,
        execution_ref: executionRef,
      },
      consumeTimeout,
    );

    if (consumption.status !== 200) {
      throw ProtocolError.internal(
        `Inntris Core token consumption failed with HTTP ${consumption.status}`,
      );
    }

    const consumed = VerifyTokenResponseSchema.safeParse(consumption.body);
    if (!consumed.success) {
      throw ProtocolError.internal(
        "Inntris Core returned a malformed token-consumption response",
      );
    }

    const data = consumed.data;
    // Every one of these must hold. A partial match means the token authorises
    // something other than what is about to execute.
    const accepted =
      data.valid === true &&
      data.verdict === "approved" &&
      data.agent_id === this.options.agentId &&
      data.action_hash === signed.actionHash &&
      data.action_hash_matches === true &&
      data.sandbox === false &&
      data.execution_ref === executionRef &&
      typeof data.consumption_audit_id === "string" &&
      (data.consumption_status === "consumed" || data.consumption_status === "idempotent");

    if (!accepted) {
      throw ProtocolError.internal(
        `Inntris Core did not confirm exact action-bound token consumption${
          data.reason ? `: ${data.reason}` : ""
        }`,
      );
    }

    return {
      outcome: "PASS",
      decisionAuditId: approved.data.audit_id,
      consumptionAuditId: data.consumption_audit_id as string,
      consumptionStatus: data.consumption_status as "consumed" | "idempotent",
      actionHash: signed.actionHash,
      trustScore: approved.data.trust_score,
    };
  }
}
