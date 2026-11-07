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

for (const choice of ["approve", "escalate"] as const)
  it.live(`fallback for ${choice} preserves modes, persistence and configured restrictions`, () =>
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
                      choice,
                      confidence: 0.9,
                      probabilities: [{ value: "approve", probability: 0.9 }],
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
      yield* client.setSession({ sessionID: session.id, change: { type: "preset", preset: "auto" } })
      const request = { sessionID: session.id, action: "shell", resources: ["git status"] }
      const empty = yield* permission.ask(request)
      expect(empty.effect).toBe("ask")
      expect(calls).toEqual([])
      expect((yield* permission.get(empty.id))?.message).toContain("No user task or saved session approval")
      yield* addUserTask(session.id, "Inspect this checkout")
      expect((yield* client.session({ sessionID: session.id })).fallback).toMatchObject({
        mode: "shadow",
        timeoutMs: 10_000,
      })
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect((yield* client.history({ sessionID: session.id })).find((entry) => entry.fallback)).toMatchObject({
        decision: "escalate",
        fallback: { mode: "shadow", applied: false, decision: "approve" },
      })
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "auto" } })
      expect((yield* permission.ask(request)).effect).toBe("allow")
      expect((yield* client.history({ sessionID: session.id })).some((entry) => entry.fallback?.applied)).toBe(true)
      const reopened = yield* PluginHost.make(plugins, reviewer.id)
      expect(yield* reopened.storage.get(`fallback/${session.id}`)).toBe("auto")
      const child = yield* host.session.create({ title: "Child", parentID: session.id })
      expect((yield* client.session({ sessionID: child.id })).fallback?.mode).toBe("shadow")
      yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "shadow" } })
      expect((yield* permission.ask(request)).effect).toBe("ask")
      yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "auto" } })
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "off" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect(calls).toEqual(["classifier"])
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "auto" } })
      yield* client.saveSettings({ patch: { reviewWith: "classifier" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect(calls).toEqual(["classifier"])
      expect((yield* client.session({ sessionID: session.id })).fallback).toBeUndefined()
      yield* client.saveSettings({ patch: { reviewWith: "reviewer" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("allow")
      expect(calls).toEqual(["chat"])
      expect((yield* client.session({ sessionID: session.id })).model.id).toBe(Model.ID.make("chat"))
      expect(
        (yield* client.history({ sessionID: session.id })).some(
          (entry) => entry.mode === "chat" && entry.model.id === "chat",
        ),
      ).toBe(true)
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "shadow" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect(calls).toEqual(["chat"])
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "off" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect(calls).toEqual([])
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "auto" } })
      yield* client.saveSettings({ patch: { reviewWith: "both" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("allow")
      expect(calls).toEqual(["classifier", "chat"])
      yield* client.setSession({ sessionID: session.id, change: { type: "automation", mode: "reviewer" } })
      expect((yield* client.session({ sessionID: session.id })).reviewWithSource).toBe("session")
      expect((yield* client.session({ sessionID: child.id })).reviewWith).toBe("both")
      expect((yield* client.settings({})).values.reviewWith).toBe("both")
      yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "manual" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("allow")
      expect(calls).toEqual(["chat"])
      yield* client.setSession({ sessionID: session.id, change: { type: "reset", target: "fallback" } })
      yield* client.saveSettings({ patch: { reviewerMode: "auto" } })
      expect((yield* client.session({ sessionID: session.id })).reviewerMode).toBe("auto")
      yield* client.setSession({ sessionID: session.id, change: { type: "fallback", mode: "off" } })
      calls.length = 0
      expect((yield* permission.ask(request)).effect).toBe("ask")
      expect(calls).toEqual([])
      yield* client.setSession({ sessionID: session.id, change: { type: "reset", target: "automation" } })
      expect((yield* client.session({ sessionID: session.id })).reviewWith).toBe("both")
      expect((yield* client.session({ sessionID: session.id })).reviewWithSource).toBe("server")
      yield* client.setSession({ sessionID: session.id, change: { type: "reviewer", mode: "auto" } })
      yield* client.setSession({ sessionID: session.id, change: { type: "reset", target: "fallback" } })
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
