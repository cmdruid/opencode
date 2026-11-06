import { expect } from "bun:test"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Permission } from "@opencode/core/permission"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Deferred, Effect, Fiber } from "effect"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { settings } from "../../../plugins/permission-review/settings"
import { testEffect } from "../lib/effect"
import { addUserTask, makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer(null, null))
const options = {
  model: Model.Ref.parse("settings/classifier"),
  mode: "decision" as const,
  defaultMode: "shadow" as const,
  policy: "Configured policy",
  minConfidence: 0.95,
}
const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const host = yield* PluginHost.make(plugins, reviewer.id)
  const providerID = Provider.ID.make("settings")
  yield* host.provider.transform((editor) =>
    editor.add({
      info: {
        id: providerID,
        name: "Settings fixture",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
      },
      models: [
        { ...Model.Info.default(providerID, Model.ID.make("classifier")), type: "decision" },
        {
          ...Model.Info.default(providerID, Model.ID.make("chat")),
          variants: [{ id: Model.VariantID.make("bounded"), body: { max_tokens: 1024 } }],
        },
      ],
    }),
  )
  return { host, plugins }
})

it.live("server settings persist, refresh other readers, clear and reset without rewriting existing session data", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const parent = yield* test.host.session.create({})
    const child = yield* test.host.session.create({ parentID: parent.id })
    const other = yield* test.host.session.create({})
    yield* test.host.storage.set(`selection/${parent.id}`, { preset: "shadow", mode: "shadow" })
    yield* test.host.storage.set(`fallback/${parent.id}`, "auto")
    yield* test.host.storage.set("review/existing", { retained: true })
    yield* reviewer.effect({ ...test.host, options })
    const client = test.host.rpc(Contract)
    const reopened = yield* PluginHost.make(test.plugins, reviewer.id)
    const reader = settings(reopened, options)
    const saved = yield* client.saveSettings({
      patch: {
        defaultMode: "manual",
        minConfidence: 0.9,
        actions: [],
        policy: "",
        fallback: { model: Model.Ref.parse("settings/chat#bounded"), mode: "shadow", timeoutMs: 500 },
      },
    })
    expect(saved.values).toMatchObject({ defaultMode: "manual", minConfidence: 0.9, actions: [], policy: "" })
    expect((yield* reader.read).values).toEqual(saved.values)
    expect(yield* client.session({ sessionID: child.id })).toMatchObject({
      mode: "shadow",
      modeSource: "ancestor",
      inheritedFrom: parent.id,
      fallback: { mode: "shadow" },
    })
    expect((yield* client.session({ sessionID: parent.id })).fallback?.mode).toBe("auto")
    expect((yield* client.session({ sessionID: other.id })).mode).toBe("manual")
    yield* client.setSession({ sessionID: parent.id, change: { type: "reset", target: "selection" } })
    expect(yield* client.session({ sessionID: child.id })).toMatchObject({ mode: "manual", modeSource: "server" })
    yield* client.setSession({ sessionID: parent.id, change: { type: "reset", target: "fallback" } })
    expect((yield* client.session({ sessionID: parent.id })).fallback?.mode).toBe("shadow")
    yield* client.saveSettings({ patch: { actions: null }, reset: ["policy", "minConfidence"] })
    expect(yield* reader.read).toMatchObject({
      values: { actions: null, policy: "Configured policy", minConfidence: 0.95 },
      sources: { policy: "configuration", minConfidence: "configuration", actions: "server" },
    })
    expect(yield* reopened.storage.get("review/existing")).toEqual({ retained: true })
    yield* client.saveSettings({ patch: { mode: "chat", model: Model.Ref.parse("settings/chat") } })
    expect((yield* client.session({ sessionID: parent.id })).fallback).toBeUndefined()
    expect((yield* client.settings({})).values.fallback?.model.variant).toBe(Model.VariantID.make("bounded"))
    yield* client.saveSettings({ patch: { mode: "decision", model: options.model } })
    expect((yield* client.session({ sessionID: parent.id })).fallback?.mode).toBe("shadow")
  }),
)

it.live("invalid server changes leave effective settings unchanged", () =>
  Effect.gen(function* () {
    const test = yield* setup
    yield* reviewer.effect({ ...test.host, options })
    const client = test.host.rpc(Contract)
    const before = yield* client.settings({})
    for (const patch of [
      { minConfidence: 2 },
      { model: Model.Ref.parse("missing/model") },
      { mode: "chat" as const },
      { fallback: { model: Model.Ref.parse("settings/chat#missing"), mode: "auto" as const, timeoutMs: 1000 } },
      { fallback: { model: Model.Ref.parse("settings/chat"), mode: "auto" as const, timeoutMs: 0 } },
    ]) {
      expect((yield* client.saveSettings({ patch }).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* client.settings({})).toEqual(before)
    }
  }),
)

it.live("a running review uses its starting threshold while the next request sees a saved threshold", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const permission = yield* Permission.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* reviewer.effect({
      ...test.host,
      options: { ...options, defaultMode: "auto" },
      experimental: {
        ...test.host.experimental,
        generate: {
          ...test.host.experimental.generate,
          decisions: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return {
                answers: [
                  {
                    type: "choice" as const,
                    name: "permission",
                    choice: "approve",
                    confidence: 0.9,
                    probabilities: [],
                  },
                ],
              }
            }),
        },
      },
    })
    const session = yield* test.host.session.create({ permissions: [{ action: "*", resource: "*", effect: "ask" }] })
    yield* addUserTask(session.id, "Inspect this checkout")
    const request = { sessionID: session.id, action: "shell", resources: ["git status"] }
    const running = yield* permission.ask(request).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    yield* test.host.rpc(Contract).saveSettings({ patch: { minConfidence: 0.85 } })
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(running)).effect).toBe("ask")
    expect((yield* permission.ask(request)).effect).toBe("allow")
    yield* permission.close
  }),
)
