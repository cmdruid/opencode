import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { Options, Overrides, ServerValues, settingKeys, type SaveSettings } from "./contract.js"

const Saved = Schema.Struct({ version: Schema.Literal(1), values: Overrides })

/** Resolve once per request; configuration remains the baseline beneath sparse server overrides. */
export function resolveSettings(options: typeof Options.Type, overrides: Overrides = {}) {
  const values: ServerValues = {
    reviewWith:
      overrides.reviewWith ??
      options.reviewWith ??
      ((overrides.mode ?? options.mode ?? "chat") === "chat"
        ? "reviewer"
        : (overrides.fallback === undefined ? options.fallback : overrides.fallback)
          ? "both"
          : "classifier"),
    model: options.model,
    mode: options.mode ?? "chat",
    minConfidence: options.minConfidence ?? 0.98,
    defaultMode: options.defaultMode ?? (options.shadow ? "shadow" : "auto"),
    actions: options.actions ?? null,
    policy: options.policy ?? "",
    fallback: options.fallback
      ? {
          model: options.fallback.model,
          mode: options.fallback.mode ?? "shadow",
          timeoutMs: options.fallback.timeoutMs ?? 10_000,
        }
      : null,
    ...overrides,
  }
  const sources = Object.fromEntries(
    settingKeys.map((key) => [
      key,
      overrides[key] !== undefined
        ? ("server" as const)
        : options[key] !== undefined || (key === "defaultMode" && options.shadow !== undefined)
          ? ("configuration" as const)
          : ("default" as const),
    ]),
  )
  return { values, sources }
}

export function reviewOptions(values: ServerValues): typeof Options.Type {
  return {
    ...values,
    actions: values.actions ?? undefined,
    policy: values.policy || undefined,
    fallback: values.fallback ?? undefined,
  }
}

export function settings(ctx: Plugin.Context, options: typeof Options.Type) {
  const overrides = Effect.gen(function* () {
    const saved = yield* ctx.storage.get("settings/server")
    if (saved === undefined) return {}
    return (yield* Schema.decodeUnknownEffect(Saved)(saved)).values
  })
  const read = overrides.pipe(Effect.map((value) => resolveSettings(options, value)))
  const save = Effect.fn(function* (input: SaveSettings) {
    const current = { ...(yield* overrides), ...input.patch }
    input.reset?.forEach((key) => delete current[key])
    const next = resolveSettings(options, current)
    if (input.patch.reviewWith) {
      if (next.values.reviewWith !== "reviewer" && next.values.mode !== "decision")
        return yield* Effect.fail(new Error("Choose a classifier model first"))
      if (next.values.reviewWith !== "classifier" && next.values.mode === "decision" && !next.values.fallback)
        return yield* Effect.fail(new Error("Choose a reviewer model first"))
    }
    // Only validate changed model choices: an unavailable existing provider must not block resetting another field.
    const refs = [
      ...(input.patch.model || input.patch.mode ? [{ model: next.values.model, type: next.values.mode }] : []),
      ...(input.patch.fallback ? [{ model: input.patch.fallback.model, type: "chat" as const }] : []),
    ]
    if (refs.length) {
      const models = yield* ctx.model.list({ types: ["chat", "decision"] })
      for (const ref of refs) {
        const model = models.data.find(
          (model) => model.providerID === ref.model.providerID && model.id === ref.model.id,
        )
        if (
          !model ||
          (model.type ?? "chat") !== ref.type ||
          (ref.model.variant && !model.variants.some((variant) => variant.id === ref.model.variant))
        )
          return yield* Effect.fail(new Error("Select an available model and variant for this reviewer type"))
      }
    }
    return { current, next }
  })
  const commit = (values: Overrides) => ctx.storage.set("settings/server", { version: 1, values })
  return { read, save, commit }
}
