import { Model, Rpc } from "@opencode/plugin/effect"
import { AssertInput, ReviewResult } from "@opencode/plugin/permission"
import { Schema } from "effect"

export const ReviewMode = Schema.Literals(["manual", "shadow", "auto"])
export type ReviewMode = typeof ReviewMode.Type

// Retain configured/shadow for saved state and existing RPC clients, outside the main selector.
export const Preset = Schema.Literals(["configured", "read-only", "workspace", "auto", "shadow", "full"])
export type Preset = typeof Preset.Type

export const Selection = Schema.Struct({ preset: Preset, mode: ReviewMode })
export type Selection = typeof Selection.Type

export const Assessment = Schema.Struct({
  ...ReviewResult.fields,
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
    choice: Schema.String,
    confidence: Schema.Number,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Schema.Number })),
    threshold: Schema.Number,
  }).pipe(Schema.optional),
})
export type Assessment = typeof Assessment.Type

export const State = Schema.Struct({
  ...Selection.fields,
  inheritedFrom: AssertInput.fields.sessionID.pipe(Schema.optional),
  model: Model.Ref,
  actions: Schema.Array(Schema.String).pipe(Schema.optional),
})
export type State = typeof State.Type

/** Experimental plugin RPC; mode choices belong to one session and survive reconnects. */
export const Contract = Rpc.define({
  id: "opencode.permission-review",
  methods: {
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
