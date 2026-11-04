import { Plugin } from "@opencode/plugin/effect"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Clock, Effect, Option, Schema } from "effect"
import { Assessment, Contract, ReviewMode } from "./contract.js"
import { Options, review } from "./review.js"

export default Plugin.define({
  id: "opencode.permission-review",
  effect: Effect.fn(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    const mode = Effect.fn(function* (sessionID: string) {
      const value = yield* ctx.storage.get(`mode/${sessionID}`)
      if (value === undefined) return options.defaultMode ?? (options.shadow ? "shadow" : "auto")
      return Option.getOrElse(Schema.decodeUnknownOption(ReviewMode)(value), () => "manual" as const)
    })
    const state = Effect.fn(function* (sessionID: string) {
      return { mode: yield* mode(sessionID), model: options.model, actions: options.actions }
    })
    const rpc: RpcRegistration<typeof Contract> = yield* ctx.rpc
      .register(Contract, {
        get: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          return yield* state(input.sessionID)
        }),
        set: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          yield* ctx.storage.set(`mode/${input.sessionID}`, input.mode)
          const next = yield* state(input.sessionID)
          yield* rpc.events.emit("changed", { sessionID: input.sessionID, state: next }).pipe(Effect.orDie)
          return next
        }),
        history: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const entries: Assessment[] = []
          let after: string | undefined
          do {
            const page = yield* ctx.storage.scan({ prefix: "review/", after, limit: 100 })
            entries.push(
              ...page.entries.flatMap((entry) => {
                const value = Schema.decodeUnknownOption(Assessment)(entry.value)
                return Option.isSome(value) && value.value.sessionID === input.sessionID ? [value.value] : []
              }),
            )
            after = page.next
          } while (after)
          return entries.toSorted((a, b) => b.at - a.at).slice(0, 50)
        }),
      })
      .pipe(Effect.orDie)
    yield* ctx.permission.hook("experimental.review", (event) =>
      Effect.gen(function* () {
        if (event.result || (options.actions && !options.actions.includes(event.request.action))) return
        const selected = yield* mode(event.request.sessionID)
        if (selected === "manual") return
        const started = yield* Clock.currentTimeMillis
        const result = yield* review(ctx, event, options).pipe(
          Effect.catch(() =>
            Effect.succeed({
              decision: "escalate" as const,
              reason: "Permission reviewer unavailable; please review the request.",
            }),
          ),
        )
        const completed = yield* Clock.currentTimeMillis
        yield* ctx.storage.set(`review/${event.request.id}`, {
          requestID: event.request.id,
          sessionID: event.request.sessionID,
          action: event.request.action,
          resources: event.request.resources,
          model: { providerID: options.model.providerID, id: options.model.id },
          mode: options.mode ?? "chat",
          shadow: selected === "shadow",
          at: completed,
          durationMs: completed - started,
          ...result,
        })
        yield* Effect.logInfo("Automatic permission review", {
          requestID: event.request.id,
          decision: result.decision,
          shadow: selected === "shadow",
          reason: result.reason,
        })
        event.result =
          selected === "shadow"
            ? {
                decision: "escalate",
                reason: `Shadow review suggests ${result.decision}: ${result.reason} Your decision is required.`,
              }
            : { decision: result.decision, reason: result.reason }
      }),
    )
  }),
})
