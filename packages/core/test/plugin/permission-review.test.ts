import { expect } from "bun:test"
import { Permission } from "@opencode/schema/permission"
import { Model } from "@opencode/schema/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Rpc } from "@opencode/core/rpc"
import { Clock, Effect, Schema } from "effect"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { testEffect } from "../lib/effect"
import { addUserTask, PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

for (const shadow of [true, false]) {
  for (const decision of ["approve", "deny", "escalate"] as const) {
    it.live(`records ${decision} and ${shadow ? "asks the user in shadow mode" : "applies the decision"}`, () =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const hooks = yield* PluginHooks.Service
        const host = yield* PluginHost.make(plugins, reviewer.id)
        const session = yield* host.session.create({ title: "Permission review trial" })
        yield* addUserTask(session.id, "Inspect this checkout")
        yield* reviewer.effect({
          ...host,
          options: { model: Model.Ref.parse("test/reviewer"), shadow },
          experimental: {
            ...host.experimental,
            generate: {
              ...host.experimental.generate,
              text: () => Effect.succeed({ text: JSON.stringify({ decision, reason: "Fixture assessment" }) }),
            },
          },
        })
        yield* host.storage.set(`selection/${session.id}`, { preset: "auto", mode: shadow ? "shadow" : "auto" })
        const event = yield* hooks.trigger("permission", "experimental.review", {
          request: {
            id: Permission.ID.create(),
            sessionID: session.id,
            action: "read",
            resources: ["src/index.ts"],
          },
        })
        expect(event.result?.decision).toBe(shadow ? "escalate" : decision)
        expect(event.result?.reason).toContain("Fixture assessment")
        if (shadow) expect(event.result?.reason).toContain("Your decision is required")
        expect(yield* host.storage.get(`review/${event.request.id}`)).toMatchObject({
          requestID: event.request.id,
          sessionID: session.id,
          decision,
          shadow,
          reason: "Fixture assessment",
          durationMs: expect.any(Number),
        })
      }),
    )
  }
}

it.live("session review modes persist, stay local to the session, and leave manual requests to the user", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const rpc = yield* Rpc.Service
    const host = yield* PluginHost.make(plugins, reviewer.id)
    const session = yield* host.session.create({ title: "Mode trial" })
    yield* addUserTask(session.id, "Inspect this checkout")
    const other = yield* host.session.create({ title: "Unchanged session" })
    const calls: string[] = []
    yield* reviewer.effect({
      ...host,
      options: { model: Model.Ref.parse("test/reviewer"), defaultMode: "shadow" },
      experimental: {
        ...host.experimental,
        generate: {
          ...host.experimental.generate,
          text: (input) =>
            Effect.sync(() => {
              calls.push(input.prompt)
              return { text: JSON.stringify({ decision: "approve", reason: "Authorized inspection" }) }
            }),
        },
      },
    })
    const client = host.rpc(Contract)
    // The generic HTTP RPC envelope encodes Schema.Json, including optional state fields.
    expect(Schema.is(Schema.Json)(yield* client.session({ sessionID: session.id }))).toBe(true)
    expect((yield* client.session({ sessionID: session.id })).mode).toBe("manual")
    yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "manual" } })
    const request = { id: Permission.ID.create(), sessionID: session.id, action: "read", resources: ["README.md"] }
    expect((yield* hooks.trigger("permission", "experimental.review", { request })).result).toBeUndefined()
    expect(calls).toHaveLength(0)
    yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "auto" } })
    expect(Schema.is(Schema.Json)(yield* client.session({ sessionID: session.id }))).toBe(true)
    expect((yield* hooks.trigger("permission", "experimental.review", { request })).result?.decision).toBe("approve")
    expect(calls).toHaveLength(1)
    expect((yield* client.session({ sessionID: other.id })).mode).toBe("manual")
    const reopened = yield* PluginHost.make(plugins, reviewer.id)
    expect(yield* reopened.storage.get(`selection/${session.id}`)).toMatchObject({ mode: "auto" })
    expect(
      yield* rpc
        .call(Contract.id, "setSession", { sessionID: session.id, change: { type: "reviewer", mode: "always" } })
        .pipe(Effect.flip),
    ).toMatchObject({ type: "rpc.invalid_input" })
    yield* host.storage.set(`mode/${session.id}`, "corrupt")
    yield* host.storage.remove(`selection/${session.id}`)
    expect((yield* client.session({ sessionID: session.id })).mode).toBe("manual")
    expect((yield* hooks.trigger("permission", "experimental.review", { request })).result).toBeUndefined()
    expect(calls).toHaveLength(1)
  }),
)

it.live("history includes legacy assessments, crosses storage pages, and returns only the session's latest 50", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, reviewer.id)
    const session = yield* host.session.create({ title: "History trial" })
    const other = yield* host.session.create({ title: "Other history" })
    const now = yield* Clock.currentTimeMillis
    yield* Effect.forEach(
      Array.from({ length: 175 }, (_, index) => index),
      (index) =>
        host.storage.set(`review/${String(index).padStart(3, "0")}`, {
          requestID: `per_history_${index}`,
          sessionID: index < 105 ? other.id : session.id,
          action: "read",
          model: { providerID: "test", id: "reviewer" },
          mode: "chat",
          shadow: true,
          at: now + index,
          durationMs: 1,
          decision: "approve",
          reason: "Recorded assessment",
        }),
    )
    yield* host.storage.set("review/invalid", { sessionID: session.id })
    yield* reviewer.effect({ ...host, options: { model: Model.Ref.parse("test/reviewer"), defaultMode: "manual" } })
    const entries = yield* host.rpc(Contract).history({ sessionID: session.id })
    expect(entries).toHaveLength(50)
    expect(entries[0].at).toBe(now + 174)
    expect(entries.at(-1)?.at).toBe(now + 125)
    expect(entries.every((entry) => entry.sessionID === session.id)).toBe(true)
    expect(entries[0].classifier).toBeUndefined()
  }),
)

for (const trial of [
  { shadow: true, confidence: 0.99, decision: "escalate" },
  { shadow: false, confidence: 0.99, decision: "approve" },
  { shadow: false, confidence: 0.5, decision: "escalate" },
] as const) {
  it.live(`audits classifier approval score ${trial.confidence} with shadow ${trial.shadow}`, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(plugins, reviewer.id)
      const session = yield* host.session.create({ title: "Classifier audit trial" })
      yield* addUserTask(session.id, "Inspect this checkout")
      yield* reviewer.effect({
        ...host,
        options: { model: Model.Ref.parse("test/reviewer"), mode: "decision", shadow: trial.shadow },
        experimental: {
          ...host.experimental,
          generate: {
            ...host.experimental.generate,
            decisions: () =>
              Effect.succeed({
                answers: [
                  {
                    type: "choice" as const,
                    name: "permission",
                    choice: "approve",
                    confidence: trial.confidence,
                    probabilities: [{ value: "approve", probability: trial.confidence }],
                  },
                ],
              }),
          },
        },
      })
      yield* host.storage.set(`selection/${session.id}`, { preset: "auto", mode: trial.shadow ? "shadow" : "auto" })
      const event = yield* hooks.trigger("permission", "experimental.review", {
        request: {
          id: Permission.ID.create(),
          sessionID: session.id,
          action: "read",
          resources: ["src/index.ts"],
        },
      })
      expect(event.result?.decision).toBe(trial.decision)
      expect(event.result).not.toHaveProperty("classifier")
      expect(yield* host.storage.get(`review/${event.request.id}`)).toMatchObject({
        decision: trial.confidence >= 0.98 ? "approve" : "escalate",
        shadow: trial.shadow,
        classifier: {
          choice: "approve",
          confidence: trial.confidence,
          probabilities: [{ value: "approve", probability: trial.confidence }],
          threshold: 0.98,
        },
      })
    }),
  )
}

it.live("pending requests receive a concise summary while history retains the full reviewer explanation", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const host = yield* PluginHost.make(plugins, reviewer.id)
    const session = yield* host.session.create({})
    yield* addUserTask(session.id, "Proceed with the approved items.")
    const reason =
      "The user references a numbered proposal that is missing from context. " + "More diagnostic detail. ".repeat(20)
    const summary = "The approved task list is missing from context."
    yield* reviewer.effect({
      ...host,
      options: { model: Model.Ref.parse("test/reviewer"), mode: "chat", shadow: false },
      experimental: {
        ...host.experimental,
        generate: {
          ...host.experimental.generate,
          text: () => Effect.succeed({ text: JSON.stringify({ decision: "escalate", summary, reason }) }),
        },
      },
    })
    yield* host.rpc(Contract).setSession({ sessionID: session.id, change: { type: "preset", preset: "auto" } })
    const event = yield* hooks.trigger("permission", "experimental.review", {
      request: { id: Permission.ID.create(), sessionID: session.id, action: "shell", resources: ["tracker.sh list"] },
    })
    expect(event.result).toEqual({ decision: "escalate", reason: `Review: Escalate\n\nReason: ${summary}` })
    expect((yield* host.rpc(Contract).history({ sessionID: session.id }))[0]).toMatchObject({
      decision: "escalate",
      summary,
      reason,
    })
  }),
)
