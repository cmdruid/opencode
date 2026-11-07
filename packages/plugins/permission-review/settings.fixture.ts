import { Model } from "@opencode/plugin/effect"
import { Schema } from "effect"
import { SaveSettings, type Overrides, type State, type Assessment, type SessionApproval } from "./contract.js"
import { resolveSettings } from "./settings.js"
import type { SettingsActions } from "./settings-ui.js"

/** Local-only data shared by the story and renderer tests, never a reviewer implementation. */
export function settingsFixture() {
  const baseline = {
    model: Model.Ref.parse("fixture/classifier"),
    mode: "decision" as const,
    defaultMode: "shadow" as const,
    minConfidence: 0.9,
    fallback: { model: Model.Ref.parse("fixture/chat"), mode: "shadow" as const },
  }
  const fixture = {
    overrides: {} as Overrides,
    session: undefined as State | undefined,
    writes: [] as SaveSettings[],
    failure: "",
    history: [] as Assessment[],
    approvals: [] as SessionApproval[],
    connection: {
      role: "classifier" as const,
      model: baseline.model,
      custom: false,
      authenticated: false,
      url: "http://localhost:1234/v1",
    },
  }
  const snapshot = () => ({
    ...resolveSettings(baseline, fixture.overrides),
    connections: [
      fixture.connection,
      { role: "fallback" as const, model: baseline.fallback.model, custom: false, authenticated: false },
    ],
  })
  const actions: SettingsActions = {
    settings: async () => snapshot(),
    session: async () => fixture.session,
    save: async (input) => {
      if (fixture.failure) throw new Error(fixture.failure)
      Schema.decodeUnknownSync(SaveSettings)(input)
      fixture.writes.push(input)
      fixture.overrides = { ...fixture.overrides, ...input.patch }
      input.reset?.forEach((key) => delete fixture.overrides[key])
      return snapshot()
    },
    change: async (change) => {
      fixture.session = {
        preset:
          change.type === "preset"
            ? change.preset
            : change.type === "reset" && change.target === "selection"
              ? "workspace"
              : (fixture.session?.preset ?? "workspace"),
        mode:
          change.type === "reviewer"
            ? change.mode
            : change.type === "preset"
              ? change.preset === "auto"
                ? "auto"
                : "manual"
              : change.type === "reset" && change.target === "selection"
                ? "manual"
                : (fixture.session?.mode ?? "manual"),
        reviewWith:
          change.type === "automation"
            ? change.mode
            : change.type === "reset" && change.target === "automation"
              ? snapshot().values.reviewWith
              : (fixture.session?.reviewWith ?? snapshot().values.reviewWith),
        reviewWithSource: change.type === "automation" ? "session" : "default",
        reviewerMode:
          change.type === "fallback"
            ? change.mode
            : change.type === "reset" && change.target === "fallback"
              ? snapshot().values.reviewerMode
              : (fixture.session?.reviewerMode ?? snapshot().values.reviewerMode),
        modeSource: "session",
        fallbackSource: "configuration",
        model: baseline.model,
      }
      return fixture.session
    },
    models: async () => [
      { providerID: "fixture", id: "classifier", type: "decision", variants: [] },
      { providerID: "fixture", id: "chat", type: "chat", variants: [{ id: "bounded" }] },
    ],
    exportDiagnostics: async () => {},
    history: async () => fixture.history,
    approvals: async () => fixture.approvals,
    revoke: async (requestID) => {
      fixture.approvals = fixture.approvals.filter((item) => item.requestID !== requestID)
    },
  }
  return { fixture, actions, snapshot }
}
