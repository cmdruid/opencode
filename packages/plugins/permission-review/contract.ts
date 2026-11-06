import { Model, Rpc } from "@opencode/plugin/effect"
import { AssertInput, ReviewResult } from "@opencode/plugin/permission"
import { Schema } from "effect"

export const ReviewMode = Schema.Literals(["manual", "shadow", "auto"])
export type ReviewMode = typeof ReviewMode.Type

export const FallbackMode = Schema.Literals(["off", "shadow", "auto"])
export type FallbackMode = typeof FallbackMode.Type

export const FallbackSettings = Schema.Struct({ model: Model.Ref, mode: FallbackMode, timeoutMs: Schema.Number })
export type FallbackSettings = typeof FallbackSettings.Type

export const FallbackAssessment = Schema.Struct({
  ...ReviewResult.fields,
  model: Model.Ref,
  mode: Schema.Literals(["shadow", "auto"]),
  trigger: Schema.Literals(["low-confidence", "uncertain"]),
  status: Schema.Literals(["completed", "invalid", "timeout", "unavailable"]),
  durationMs: Schema.Number,
  applied: Schema.Boolean,
})
export type FallbackAssessment = typeof FallbackAssessment.Type

// Retain configured/shadow for saved state and existing RPC clients, outside the main selector.
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
  classifier: Schema.Struct({
    choice: Schema.Union([Schema.String, Schema.Boolean]),
    confidence: Schema.Number,
    probabilities: Schema.Array(
      Schema.Struct({ value: Schema.Union([Schema.String, Schema.Boolean]), probability: Schema.Number }),
    ),
    threshold: Schema.Number,
  }).pipe(Schema.optional),
})
export type Assessment = typeof Assessment.Type

export const State = Schema.Struct({
  ...Selection.fields,
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
    setFallback: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID, mode: FallbackMode })),
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
    get: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(State),
    },
    set: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID, mode: ReviewMode })),
      output: Schema.toStandardSchemaV1(State),
    },
    select: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID, preset: Preset })),
      output: Schema.toStandardSchemaV1(State),
    },
    history: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID })),
      output: Schema.toStandardSchemaV1(Schema.Array(Assessment)),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: AssertInput.fields.sessionID, state: State })),
    },
  },
})
