import { Schema } from "effect"
import { SaveSettings } from "./contract"
import { expect, test } from "bun:test"
import { Model } from "@opencode/plugin/effect"
import { resolveSettings, reviewOptions } from "./settings"
import { matchesPreset } from "./settings-ui"

const options = {
  model: Model.Ref.parse("fixture/model"),
  policy: "Configured policy",
  actions: ["read"],
  defaultMode: "shadow" as const,
}

test("sparse overrides distinguish clear, all actions, and configured inheritance", () => {
  const resolved = resolveSettings(options, { policy: "", actions: null, minConfidence: 0.9, fallback: null })
  expect(resolved.values).toMatchObject({
    policy: "",
    actions: null,
    defaultMode: "shadow",
    minConfidence: 0.9,
    fallback: null,
  })
  expect(resolved.sources).toMatchObject({
    policy: "server",
    actions: "server",
    defaultMode: "configuration",
    mode: "default",
    model: "configuration",
  })
  expect(reviewOptions(resolved.values)).toMatchObject({ policy: undefined, actions: undefined, fallback: undefined })
  expect(resolveSettings(options).values).toMatchObject({
    policy: "Configured policy",
    actions: ["read"],
    minConfidence: 0.98,
  })
  expect(resolveSettings(options, { actions: [] }).values.actions).toEqual([])
})

test.each([undefined, false, true])("legacy shadow option %s retains its default behavior and source", (shadow) => {
  const resolved = resolveSettings({ model: options.model, ...(shadow === undefined ? {} : { shadow }) })
  expect(resolved.values.defaultMode).toBe(shadow ? "shadow" : "auto")
  expect(resolved.sources.defaultMode).toBe(shadow === undefined ? "default" : "configuration")
})

test("quick preset highlighting reflects scope plus reviewer, including historical selections", () => {
  const state = {
    model: options.model,
    preset: "auto" as const,
    mode: "manual" as const,
    modeSource: "session" as const,
    fallbackSource: "default" as const,
  }
  expect(matchesPreset(state, "auto")).toBe(false)
  expect(matchesPreset(state, "workspace")).toBe(true)
  expect(matchesPreset({ ...state, preset: "read-only", mode: "auto" }, "read-only")).toBe(false)
  expect(matchesPreset({ ...state, preset: "shadow", mode: "shadow" }, "workspace")).toBe(false)
  expect(matchesPreset({ ...state, preset: "configured" }, "full")).toBe(true)
})

test.each([
  { minConfidence: -0.1 },
  { minConfidence: 1.01 },
  { fallback: { model: options.model, mode: "shadow", timeoutMs: 99 } },
  { fallback: { model: options.model, mode: "shadow", timeoutMs: 15001 } },
  { fallback: { model: options.model, mode: "shadow", timeoutMs: 100.5 } },
])("wire schema rejects out-of-bounds settings %j", (patch) => {
  expect(() => Schema.decodeUnknownSync(SaveSettings)({ patch })).toThrow()
})

test("review workflow defaults preserve legacy chat, classifier-only and combined configuration", () => {
  expect(resolveSettings(options).values.reviewWith).toBe("reviewer")
  expect(resolveSettings({ ...options, mode: "decision" }).values.reviewWith).toBe("classifier")
  const combined = { ...options, mode: "decision" as const, fallback: { model: options.model } }
  expect(resolveSettings(combined).values.reviewWith).toBe("both")
  expect(resolveSettings(combined, { reviewWith: "reviewer" }).values.reviewWith).toBe("reviewer")
  expect(resolveSettings(combined, { fallback: null }).values.reviewWith).toBe("classifier")
})
