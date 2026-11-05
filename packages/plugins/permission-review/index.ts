import { Plugin } from "@opencode/plugin/effect"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Clock, Effect, Option, Schema } from "effect"
import path from "node:path"
import type { AssertInput } from "@opencode/plugin/permission"
import { Assessment, Contract, ReviewMode, Selection, SessionApproval } from "./contract.js"
import { Options, review } from "./review.js"

export default Plugin.define({
  id: "opencode.permission-review",
  effect: Effect.fn(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    const approvals = Effect.fn(function* (sessionID: AssertInput["sessionID"]) {
      const entries: SessionApproval[] = []
      let after: string | undefined
      do {
        const page = yield* ctx.storage.scan({ prefix: `approval/${sessionID}/`, after, limit: 100 })
        entries.push(
          ...page.entries.flatMap((entry) => {
            const value = Schema.decodeUnknownOption(SessionApproval)(entry.value)
            return Option.isSome(value) && value.value.sessionID === sessionID ? [value.value] : []
          }),
        )
        after = page.next
      } while (after)
      return entries.toSorted((a, b) => b.at - a.at)
    })
    const mode = Effect.fn(function* (sessionID: string) {
      const value = yield* ctx.storage.get(`mode/${sessionID}`)
      if (value === undefined) return options.defaultMode ?? (options.shadow ? "shadow" : "auto")
      return Option.getOrElse(Schema.decodeUnknownOption(ReviewMode)(value), () => "manual" as const)
    })
    const selection = Effect.fn(function* (sessionID: AssertInput["sessionID"]) {
      let session = yield* ctx.session.get({ sessionID }).pipe(Effect.orDie)
      while (true) {
        const value = yield* ctx.storage.get(`selection/${session.id}`)
        if (value !== undefined)
          return {
            ...Option.getOrElse(Schema.decodeUnknownOption(Selection)(value), () => ({
              preset: "read-only" as const,
              mode: "manual" as const,
            })),
            ...(session.id === sessionID ? {} : { inheritedFrom: session.id }),
          }
        if (!session.parentID) break
        session = yield* ctx.session.get({ sessionID: session.parentID }).pipe(Effect.orDie)
      }
      return { preset: "configured" as const, mode: yield* mode(sessionID) }
    })
    const state = Effect.fn(function* (sessionID: AssertInput["sessionID"]) {
      return {
        ...(yield* selection(sessionID)),
        model: options.model,
        ...(options.actions ? { actions: options.actions } : {}),
      }
    })
    const rpc: RpcRegistration<typeof Contract> = yield* ctx.rpc
      .register(Contract, {
        allowSession: Effect.fn(function* (input) {
          // Resolve the pending request on the server; a client cannot invent an approval example.
          const pending = yield* ctx.permission.list({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const request = pending.find((request) => request.id === input.requestID)
          if (!request) return yield* Effect.die(new Error("Permission request is no longer pending"))
          const history = yield* ctx.session.context({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const user = history.findLast((message) => message.type === "user")
          const approval = yield* Schema.decodeUnknownEffect(SessionApproval)({
            requestID: request.id,
            sessionID: request.sessionID,
            action: request.action,
            resources: request.resources,
            ...(request.metadata ? { metadata: request.metadata } : {}),
            directory: ctx.location.directory,
            toolCalls: history
              .filter((message) => message.type === "assistant")
              .filter((message) => message.id === request.source?.messageID)
              .flatMap((message) => message.content)
              .flatMap((part) =>
                part.type === "tool" && part.id === request.source?.id && part.state.status !== "streaming"
                  ? [{ name: part.name, input: part.state.input }]
                  : [],
              ),
            ...(user ? { afterUserMessageID: user.id } : {}),
            at: yield* Clock.currentTimeMillis,
          }).pipe(Effect.orDie)
          // Store only after a successful explicit reply. Model approvals and ordinary once/always replies never enter here.
          yield* ctx.permission
            .reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
            .pipe(Effect.orDie)
          yield* ctx.storage.set(`approval/${input.sessionID}/${request.id}`, approval)
          return approval
        }),
        approvals: Effect.fn(function* (input) {
          yield* ctx.session.get(input).pipe(Effect.orDie)
          return yield* approvals(input.sessionID)
        }),
        revoke: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          yield* ctx.storage.remove(`approval/${input.sessionID}/${input.requestID}`)
        }),
        get: Effect.fn(function* (input) {
          return yield* state(input.sessionID)
        }),
        set: Effect.fn(function* (input) {
          const current = yield* selection(input.sessionID)
          const preset =
            current.preset === "workspace" || current.preset === "auto" || current.preset === "shadow"
              ? input.mode === "manual"
                ? "workspace"
                : input.mode
              : current.preset
          yield* ctx.storage.set(`mode/${input.sessionID}`, input.mode)
          yield* ctx.storage.set(`selection/${input.sessionID}`, { preset, mode: input.mode })
          const next = yield* state(input.sessionID)
          yield* rpc.events.emit("changed", { sessionID: input.sessionID, state: next }).pipe(Effect.orDie)
          return next
        }),
        select: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const mode =
            input.preset === "configured"
              ? (options.defaultMode ?? (options.shadow ? "shadow" : "auto"))
              : input.preset === "auto" || input.preset === "shadow"
                ? input.preset
                : "manual"
          yield* ctx.storage.set(`selection/${input.sessionID}`, { preset: input.preset, mode })
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
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.effect === "deny") return
        const selected = yield* selection(event.sessionID)
        // Scope presets may tighten OpenCode's decision, never relax it.
        if (selected.preset === "configured" || selected.preset === "full") return
        // Glob and grep authorize their search directory through external_directory first.
        if (["glob", "grep", "question"].includes(event.action)) return
        if (event.action === "read" || (event.action === "edit" && selected.preset !== "read-only")) {
          const internal = event.resources.every((resource) => {
            const relative = path.relative(ctx.location.directory, path.resolve(ctx.location.directory, resource))
            return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          })
          if (internal) return
        }
        // Restrict saved grants as well as configured allows. Never grant a configured denial.
        event.effect = "ask"
      }),
    )
    yield* ctx.permission.hook("experimental.review", (event) =>
      Effect.gen(function* () {
        if (event.result || (options.actions && !options.actions.includes(event.request.action))) return
        const selected = (yield* selection(event.request.sessionID)).mode
        if (selected === "manual") return
        const started = yield* Clock.currentTimeMillis
        const remembered = (yield* approvals(event.request.sessionID))
          .filter((entry) => entry.action === event.request.action)
          .slice(0, 20)
        const result = yield* review(ctx, event, options, remembered).pipe(
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
