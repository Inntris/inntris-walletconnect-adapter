import { z } from "zod";

/**
 * Strict schemas for every Inntris Core response the adapter acts on.
 *
 * `.strict()` is deliberate: an unexpected field means the adapter and Core
 * disagree about the contract, and a fail-closed adapter should refuse rather
 * than proceed on a response it does not fully understand. Nothing here uses
 * `any` — an unparseable response is an authority failure, not a shape to
 * coerce.
 */

const UuidSchema = z.uuid();
const ActionHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const TimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO-8601 timestamp",
});

export const VerifyApprovedResponseSchema = z
  .object({
    verdict: z.literal("approved"),
    verdict_reason: z.string().nullable().optional(),
    approval_token: z.string().min(1),
    trust_score: z.number().int().min(0).max(100),
    audit_id: UuidSchema,
    timestamp: TimestampSchema,
    limits_remaining: z.record(z.string(), z.unknown()).nullable().optional(),
    idempotency_status: z.enum(["new", "replayed"]).nullable().optional(),
  })
  .strict();

export const VerifyDeniedResponseSchema = z
  .object({
    verdict: z.enum(["blocked", "rate_limited"]),
    violation_code: z.string().min(1),
    audit_id: UuidSchema,
    timestamp: TimestampSchema,
    detail: z.string().min(1),
    idempotency_status: z.enum(["new", "replayed"]).nullable().optional(),
  })
  .strict();

export const VerifyTokenResponseSchema = z
  .object({
    valid: z.boolean(),
    reason: z.string().nullable().optional(),
    verdict: z.string().nullable().optional(),
    agent_id: z.string().nullable().optional(),
    action_hash: ActionHashSchema.nullable().optional(),
    expires_at: TimestampSchema.nullable().optional(),
    action_hash_matches: z.boolean().nullable().optional(),
    consumption_audit_id: UuidSchema.nullable().optional(),
    consumption_status: z.enum(["consumed", "idempotent"]).nullable().optional(),
    execution_ref: z.string().nullable().optional(),
    sandbox: z.boolean().nullable().optional(),
  })
  .strict();

export type VerifyApprovedResponse = z.infer<typeof VerifyApprovedResponseSchema>;
export type VerifyDeniedResponse = z.infer<typeof VerifyDeniedResponseSchema>;
export type VerifyTokenResponse = z.infer<typeof VerifyTokenResponseSchema>;

/** The `info` descriptor a CWP provider returns. */
export const ProviderInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    rdns: z.string().min(1).optional(),
    capabilities: z.array(z.string()),
    chains: z.array(z.string()),
  })
  .loose();

export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;
