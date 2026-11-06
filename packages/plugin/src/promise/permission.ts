import type { PermissionApi } from "@opencode/client/promise/api"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { AssertInput, PermissionReview } from "../permission.js"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
  /** Experimental: one-request approval, denial or escalation. Not called by permission probes. */
  readonly "experimental.review": PermissionReview
}

export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
  /**
   * Evaluates the session's permission rules and, when approval is required, prompts the user and
   * waits for the reply. Resolves when allowed. A deny rule or a rejection with feedback rejects with
   * a `Tool.Error` carrying the reason. A plain rejection rejects with an error that ends the current
   * step; rethrow it rather than returning it as tool output.
   */
  readonly assert: (input: typeof AssertInput.Encoded) => Promise<void>
}

/** Experimental: re-evaluate queued requests after new authorization evidence. */
export interface ExperimentalPermissionDomain {
  /**
   * Rechecks pending requests for this session and action against current rules and review hooks.
   * Only approvals settle requests; every other outcome stays pending. No saved grants are created.
   */
  readonly reviewPending: (input: { sessionID: Session.ID; action: string }) => Promise<void>
}
