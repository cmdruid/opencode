import { Plugin } from "@opencode/plugin/effect"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Clock, Effect, Option, Schema } from "effect"
import path from "node:path"
import type { AssertInput } from "@opencode/plugin/permission"
import { Assessment, Contract, FallbackMode, ReviewMode, Selection, SessionApproval } from "./contract.js"
import { Options, review } from "./review.js"
import { connections } from "./connections.js"
import { settings, reviewOptions } from "./settings.js"

const MissingModel = Schema.Struct({
  _tag: Schema.Literal("Generate.ModelNotFoundError"),
  providerID: Schema.String,
  modelID: Schema.String,
})

export default Plugin.define({
  id: "opencode.permission-review",
  effect: Effect.fn(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    const config = settings(ctx, options)
    const currentOptions = config.read.pipe(Effect.map((value) => reviewOptions(value.values)))
    const connection = yield* connections(ctx, options, currentOptions)
    const server = Effect.gen(function* () {
      const value = yield* config.read
      return { ...value, connections: yield* connection.list() }
    })
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
    const mode = Effect.fn(function* (sessionID: string, values: typeof Options.Type) {
      const value = yield* ctx.storage.get(`mode/${sessionID}`)
      if (value === undefined) return values.defaultMode ?? "auto"
      return Option.getOrElse(Schema.decodeUnknownOption(ReviewMode)(value), () => "manual" as const)
    })
    const selection = Effect.fn(function* (sessionID: AssertInput["sessionID"], values: typeof Options.Type) {
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
      return { preset: "configured" as const, mode: yield* mode(sessionID, values) }
    })
    const fallback = Effect.fn(function* (sessionID: AssertInput["sessionID"], values: typeof Options.Type) {
      if (!values.fallback || values.mode !== "decision") return undefined
      const value = yield* ctx.storage.get(`fallback/${sessionID}`)
      return {
        model: yield* connection.model("fallback", values).pipe(Effect.orDie),
        mode:
          value === undefined
            ? (values.fallback.mode ?? "shadow")
            : Option.getOrElse(Schema.decodeUnknownOption(FallbackMode)(value), () => "off" as const),
        timeoutMs: values.fallback.timeoutMs ?? 10_000,
      }
    })
    const state = Effect.fn(function* (sessionID: AssertInput["sessionID"]) {
      const configState = yield* config.read
      const values = reviewOptions(configState.values)
      const chat = yield* fallback(sessionID, values)
      const selected = yield* selection(sessionID, values)
      const explicit = yield* ctx.storage.get(`selection/${sessionID}`)
      const legacy = yield* ctx.storage.get(`mode/${sessionID}`)
      const chatMode = yield* ctx.storage.get(`fallback/${sessionID}`)
      return {
        ...selected,
        modeSource: selected.inheritedFrom
          ? ("ancestor" as const)
          : explicit !== undefined || legacy !== undefined
            ? ("session" as const)
            : configState.sources.defaultMode,
        fallbackSource: chatMode !== undefined ? ("session" as const) : configState.sources.fallback,
        model: yield* connection.model("classifier", values).pipe(Effect.orDie),
        ...(values.actions ? { actions: values.actions } : {}),
        ...(chat ? { fallback: chat } : {}),
      }
    })
    const rpc: RpcRegistration<typeof Contract> = yield* ctx.rpc
      .register(Contract, {
        settings: () => server.pipe(Effect.orDie),
        saveSettings: Effect.fn(function* (input) {
          const next = yield* config.save(input).pipe(Effect.orDie)
          if (input.connection) yield* connection.set(input.connection).pipe(Effect.orDie)
          yield* config.commit(next.current)
          const saved = yield* server.pipe(Effect.orDie)
          yield* rpc.events.emit("settingsChanged", {}).pipe(Effect.orDie)
          return saved
        }),
        session: Effect.fn(function* (input) {
          return yield* state(input.sessionID).pipe(Effect.orDie)
        }),
        setSession: Effect.fn(function* (input) {
          yield* ctx.session.get({ sessionID: input.sessionID }).pipe(Effect.orDie)
          const values = yield* currentOptions.pipe(Effect.orDie)
          const change = input.change
          if (change.type === "reset") {
            yield* ctx.storage.remove(`${change.target === "selection" ? "selection" : "fallback"}/${input.sessionID}`)
            if (change.target === "selection") yield* ctx.storage.remove(`mode/${input.sessionID}`)
          }
          if (change.type === "fallback") {
            if (!values.fallback || values.mode !== "decision")
              return yield* Effect.die(new Error("Configure a second opinion for the classifier first"))
            yield* ctx.storage.set(`fallback/${input.sessionID}`, change.mode)
          }
          if (change.type === "preset") {
            yield* ctx.storage.set(`selection/${input.sessionID}`, {
              preset: change.preset,
              mode: change.preset === "auto" ? "auto" : "manual",
            })
          }
          if (change.type === "reviewer") {
            const selected = yield* selection(input.sessionID, values)
            yield* ctx.storage.set(`selection/${input.sessionID}`, { preset: selected.preset, mode: change.mode })
          }
          const next = yield* state(input.sessionID).pipe(Effect.orDie)
          yield* rpc.events.emit("changed", { sessionID: input.sessionID, state: next }).pipe(Effect.orDie)
          return next
        }),
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
          // Older hosts can still use remembered approvals for future requests.
          if (ctx.experimental.permission)
            yield* ctx.experimental.permission.reviewPending({ sessionID: input.sessionID, action: request.action })
          if (!ctx.experimental.permission)
            yield* Effect.logWarning("Update OpenCode to recheck queued permissions after Allow Session")
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
        const selected = yield* selection(event.sessionID, yield* currentOptions.pipe(Effect.orDie))
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
        if (event.result) return
        const values = yield* currentOptions.pipe(Effect.orDie)
        if (values.actions && !values.actions.includes(event.request.action)) return
        const selected = (yield* selection(event.request.sessionID, values)).mode
        if (selected === "manual") return
        const started = yield* Clock.currentTimeMillis
        const remembered = (yield* approvals(event.request.sessionID))
          .filter((entry) => entry.action === event.request.action)
          .slice(0, 20)
        const chat = yield* fallback(event.request.sessionID, values)
        const model = yield* connection.model("classifier", values).pipe(Effect.orDie)
        const result = yield* review(ctx, event, { ...values, model, fallback: chat }, remembered).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              decision: "escalate" as const,
              reason: Option.isSome(Schema.decodeUnknownOption(MissingModel)(error))
                ? `Classifier model ${values.model.providerID}/${values.model.id} is unavailable; check Model and Connection in permission settings.`
                : "Permission reviewer unavailable; please review the request.",
            }),
          ),
        )
        const completed = yield* Clock.currentTimeMillis
        yield* ctx.storage.set(`review/${event.request.id}`, {
          requestID: event.request.id,
          sessionID: event.request.sessionID,
          action: event.request.action,
          resources: event.request.resources,
          model: { providerID: model.providerID, id: model.id },
          mode: values.mode ?? "chat",
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
