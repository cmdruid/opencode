import { Model, Rpc } from "@opencode/plugin/effect"
import { AssertInput, ReviewResult } from "@opencode/plugin/permission"
import { Schema } from "effect"

export const ReviewMode = Schema.Literals(["manual", "shadow", "auto"])
export type ReviewMode = typeof ReviewMode.Type

export const FallbackMode = Schema.Literals(["off", "shadow", "auto"])
export type FallbackMode = typeof FallbackMode.Type

export const ReviewWith = Schema.Literals(["classifier", "reviewer", "both"])

export const ConnectionRole = Schema.Literals(["classifier", "fallback"])
export type ConnectionRole = typeof ConnectionRole.Type

export const ConnectionSettings = Schema.Struct({
  role: ConnectionRole,
  model: Model.Ref,
  url: Schema.String.pipe(Schema.optional),
  custom: Schema.Boolean,
  authenticated: Schema.Boolean,
})
export type ConnectionSettings = typeof ConnectionSettings.Type

export const ConnectionInput = Schema.Struct({
  role: ConnectionRole,
  // Omit the URL to restore the configured provider. Omit the key to keep it
  // only when the endpoint is unchanged; an empty key selects no authentication.
  url: Schema.String.pipe(Schema.optional),
  apiKey: Schema.String.pipe(Schema.optional),
})
export type ConnectionInput = typeof ConnectionInput.Type

export const FallbackSettings = Schema.Struct({ model: Model.Ref, mode: FallbackMode, timeoutMs: Schema.Number })
export type FallbackSettings = typeof FallbackSettings.Type

export const Options = Schema.Struct({
  reviewWith: ReviewWith.pipe(Schema.optional),
  reviewerMode: FallbackMode.pipe(Schema.optional),
  model: Model.Ref,
  mode: Schema.Literals(["chat", "decision"]).pipe(Schema.optional),
  policy: Schema.String.pipe(Schema.optional),
  autoAllowTools: Schema.Array(Schema.Literals(["skill", "todowrite"])).pipe(Schema.optional),
  workspaceReads: Schema.Boolean.pipe(Schema.optional),
  actions: Schema.Array(Schema.String).pipe(Schema.optional),
  shadow: Schema.Boolean.pipe(Schema.optional),
  defaultMode: ReviewMode.pipe(Schema.optional),
  minConfidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
  fallback: Schema.Struct({
    model: Model.Ref,
    mode: FallbackMode.pipe(Schema.optional),
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 15_000 })).pipe(Schema.optional),
  }).pipe(Schema.optional),
})

export const SettingKey = Schema.Literals([
  "reviewWith",
  "reviewerMode",
  "model",
  "mode",
  "minConfidence",
  "defaultMode",
  "autoAllowTools",
  "workspaceReads",
  "actions",
  "policy",
  "fallback",
])
export type SettingKey = typeof SettingKey.Type
export const settingKeys = SettingKey.literals
export const ValueSource = Schema.Literals(["default", "configuration", "server"])
export const ServerValues = Schema.Struct({
  reviewWith: ReviewWith,
  reviewerMode: FallbackMode,
  model: Model.Ref,
  mode: Schema.Literals(["chat", "decision"]),
  minConfidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  defaultMode: ReviewMode,
  autoAllowTools: Schema.Array(Schema.Literals(["skill", "todowrite"])),
  workspaceReads: Schema.Boolean,
  actions: Schema.NullOr(Schema.Array(Schema.String)),
  policy: Schema.String,
  fallback: Schema.NullOr(
    Schema.Struct({
      model: Model.Ref,
      mode: FallbackMode,
      timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 15_000 })),
    }),
  ),
})
export type ServerValues = typeof ServerValues.Type
export const Overrides = Schema.Struct({
  reviewWith: ReviewWith.pipe(Schema.optional),
  reviewerMode: FallbackMode.pipe(Schema.optional),
  model: ServerValues.fields.model.pipe(Schema.optional),
  mode: ServerValues.fields.mode.pipe(Schema.optional),
  minConfidence: ServerValues.fields.minConfidence.pipe(Schema.optional),
  defaultMode: ServerValues.fields.defaultMode.pipe(Schema.optional),
  autoAllowTools: ServerValues.fields.autoAllowTools.pipe(Schema.optional),
  workspaceReads: ServerValues.fields.workspaceReads.pipe(Schema.optional),
  actions: ServerValues.fields.actions.pipe(Schema.optional),
  policy: ServerValues.fields.policy.pipe(Schema.optional),
  fallback: ServerValues.fields.fallback.pipe(Schema.optional),
})
export type Overrides = typeof Overrides.Type
export const ServerSettings = Schema.Struct({
  values: ServerValues,
  sources: Schema.Record(Schema.String, ValueSource),
  connections: Schema.Array(ConnectionSettings),
})
export type ServerSettings = typeof ServerSettings.Type
export const SaveSettings = Schema.Struct({
  patch: Overrides,
  reset: Schema.Array(SettingKey).pipe(Schema.optional),
  connection: ConnectionInput.pipe(Schema.optional),
})
export type SaveSettings = typeof SaveSettings.Type

export const FallbackAssessment = Schema.Struct({
  ...ReviewResult.fields,
  summary: Schema.String.pipe(Schema.optional),
  details: Schema.String.pipe(Schema.optional),
  model: Model.Ref,
  mode: Schema.Literals(["shadow", "auto"]),
  trigger: Schema.Literals(["low-confidence", "uncertain"]),
  status: Schema.Literals(["completed", "invalid", "timeout", "unavailable"]),
  durationMs: Schema.Number,
  applied: Schema.Boolean,
})
export type FallbackAssessment = typeof FallbackAssessment.Type

// Historical stored selections are normalized at the settings boundary.
export const Preset = Schema.Literals(["configured", "read-only", "workspace", "auto", "shadow", "full"])
export type Preset = typeof Preset.Type

export const Selection = Schema.Struct({ preset: Preset, mode: ReviewMode })
export type Selection = typeof Selection.Type

export const SessionApproval = Schema.Struct({
  requestID: Schema.String,
  sessionID: AssertInput.fields.sessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(Schema.optional),
  directory: Schema.String,
  toolCalls: Schema.Array(Schema.Struct({ name: Schema.String, input: Schema.Record(Schema.String, Schema.Json) })),
  afterUserMessageID: Schema.String.pipe(Schema.optional),
  at: Schema.Number,
})
export type SessionApproval = typeof SessionApproval.Type

export const Assessment = Schema.Struct({
  ...ReviewResult.fields,
  summary: Schema.String.pipe(Schema.optional),
  details: Schema.String.pipe(Schema.optional),
  fallback: FallbackAssessment.pipe(Schema.optional),
  requestID: Schema.String,
  sessionID: AssertInput.fields.sessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String).pipe(Schema.optional),
  model: Model.Ref,
  mode: Schema.Literals(["chat", "decision"]),
  shadow: Schema.Boolean,
  at: Schema.Number,
  durationMs: Schema.Number,
  path: Schema.Literals(["tool-rule", "workspace-read", "model"]).pipe(Schema.optional),
  diagnostics: Schema.Record(Schema.String, Schema.Json).pipe(Schema.optional),
  reply: Schema.Struct({ decision: Schema.String, at: Schema.Number }).pipe(Schema.optional),
  classifier: Schema.Struct({
    choice: Schema.Union([Schema.String, Schema.Boolean]),
    confidence: Schema.Number,
    probabilities: Schema.Array(
      Schema.Struct({ value: Schema.Union([Schema.String, Schema.Boolean]), probability: Schema.Number }),
    ),
    threshold: Schema.Number,
    approvalScore: Schema.Number.pipe(Schema.optional),
    thresholdMetric: Schema.Literals(["approval-score", "confidence"]).pipe(Schema.optional),
  }).pipe(Schema.optional),
})
export type Assessment = typeof Assessment.Type

export const State = Schema.Struct({
  reviewWith: ReviewWith.pipe(Schema.optional),
  reviewWithSource: Schema.Literals(["default", "configuration", "server", "session"]).pipe(Schema.optional),
  reviewerMode: FallbackMode.pipe(Schema.optional),
  ...Selection.fields,
  modeSource: Schema.Literals(["default", "configuration", "server", "session", "ancestor"]),
  fallbackSource: Schema.Literals(["default", "configuration", "server", "session"]),
  fallback: FallbackSettings.pipe(Schema.optional),
  inheritedFrom: AssertInput.fields.sessionID.pipe(Schema.optional),
  model: Model.Ref,
  actions: Schema.Array(Schema.String).pipe(Schema.optional),
})
export type State = typeof State.Type

/** Experimental plugin RPC; mode choices belong to one session and survive reconnects. */
export const Contract = Rpc.define({
  id: "opencode.permission-review",
  methods: {
    settings: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(ServerSettings),
    },
    saveSettings: {
      input: Schema.toStandardSchemaV1(SaveSettings),
      output: Schema.toStandardSchemaV1(ServerSettings),
    },
    session: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(State),
    },
    setSession: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: AssertInput.fields.sessionID,
          change: Schema.Union([
            Schema.Struct({
              type: Schema.Literal("preset"),
              preset: Schema.Literals(["read-only", "workspace", "auto", "full"]),
            }),
            Schema.Struct({ type: Schema.Literal("automation"), mode: ReviewWith }),
            Schema.Struct({ type: Schema.Literal("reviewer"), mode: ReviewMode }),
            Schema.Struct({ type: Schema.Literal("fallback"), mode: FallbackMode }),
            Schema.Struct({
              type: Schema.Literal("reset"),
              target: Schema.Literals(["selection", "fallback", "automation"]),
            }),
          ]),
        }),
      ),
      output: Schema.toStandardSchemaV1(State),
    },
    allowSession: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: AssertInput.fields.sessionID, requestID: Schema.String }),
      ),
      output: Schema.toStandardSchemaV1(SessionApproval),
    },
    approvals: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(Schema.Array(SessionApproval)),
    },
    revoke: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ sessionID: AssertInput.fields.sessionID, requestID: Schema.String }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Void),
    },
    exportDiagnostics: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(Schema.Array(Assessment)),
    },
    history: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(Schema.Array(Assessment)),
    },
  },
  events: {
    settingsChanged: { schema: Schema.toStandardSchemaV1(Schema.Struct({})) },
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID, state: State })),
    },
  },
})

export function percent(value: number) {
  return `${Number((value * 100).toFixed(2))}%`
}
