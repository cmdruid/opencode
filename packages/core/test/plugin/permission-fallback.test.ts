import { expect } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { testEffect } from "../lib/effect"
import { addUserTask, makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer(null))

it.live("fallback settings persist per session, default to shadow, and preserve human and configured limits", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const permission = yield* Permission.Service
    const host = yield* PluginHost.make(plugins, reviewer.id)
    const session = yield* host.session.create({
      title: "Fallback test",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    })
    const calls: string[] = []
    yield* reviewer.effect({
      ...host,
      options: {
        model: Model.Ref.parse("test/classifier"),
        mode: "decision",
        defaultMode: "auto",
        minConfidence: 0.95,
        fallback: { model: Model.Ref.parse("test/chat#bounded") },
      },
      experimental: {
        ...host.experimental,
        generate: {
          ...host.experimental.generate,
          decisions: () =>
            Effect.sync(() => {
              calls.push("classifier")
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
          text: () =>
            Effect.sync(() => {
              calls.push("chat")
              return { text: '{"decision":"approve","reason":"Scoped fixture"}' }
            }),
        },
      },
    })
    const client = host.rpc(Contract)
    const request = { sessionID: session.id, action: "shell", resources: ["git status"] }
    const empty = yield* permission.ask(request)
    expect(empty.effect).toBe("ask")
    expect(calls).toEqual([])
    expect((yield* permission.get(empty.id))?.message).toContain("No user task or saved session approval")
    yield* addUserTask(session.id, "Inspect this checkout")
    expect((yield* client.get({ sessionID: session.id })).fallback).toMatchObject({ mode: "shadow", timeoutMs: 10_000 })
    expect((yield* permission.ask(request)).effect).toBe("ask")
    expect((yield* client.history({ sessionID: session.id })).find((entry) => entry.fallback)).toMatchObject({
      decision: "escalate",
      fallback: { mode: "shadow", applied: false, decision: "approve" },
    })
    yield* client.setFallback({ sessionID: session.id, mode: "auto" })
    expect((yield* permission.ask(request)).effect).toBe("allow")
    expect((yield* client.history({ sessionID: session.id })).some((entry) => entry.fallback?.applied)).toBe(true)
    const reopened = yield* PluginHost.make(plugins, reviewer.id)
    expect(yield* reopened.storage.get(`fallback/${session.id}`)).toBe("auto")
    const child = yield* host.session.create({ title: "Child", parentID: session.id })
    expect((yield* client.get({ sessionID: child.id })).fallback?.mode).toBe("shadow")
    yield* client.set({ sessionID: session.id, mode: "shadow" })
    expect((yield* permission.ask(request)).effect).toBe("ask")
    yield* client.set({ sessionID: session.id, mode: "auto" })
    yield* client.setFallback({ sessionID: session.id, mode: "off" })
    calls.length = 0
    expect((yield* permission.ask(request)).effect).toBe("ask")
    expect(calls).toEqual(["classifier"])
    yield* client.setFallback({ sessionID: session.id, mode: "auto" })
    yield* host.session.update({
      sessionID: session.id,
      permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    })
    calls.length = 0
    expect((yield* permission.ask(request)).effect).toBe("deny")
    expect(calls).toEqual([])
    yield* permission.close
  }),
)
