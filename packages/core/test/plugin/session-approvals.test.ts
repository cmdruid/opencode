import { expect } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Model } from "@opencode/schema/model"
import { Effect, Exit } from "effect"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer(null))
const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const permission = yield* Permission.Service
  const host = yield* PluginHost.make(plugins, reviewer.id)
  const session = yield* host.session.create({
    title: "Session approvals",
    permissions: [{ action: "*", resource: "*", effect: "ask" }],
  })
  const prompts: string[] = []
  yield* reviewer.effect({
    ...host,
    options: { model: Model.Ref.parse("test/reviewer"), defaultMode: "manual" },
    experimental: {
      ...host.experimental,
      generate: {
        ...host.experimental.generate,
        text: (input) =>
          Effect.sync(() => {
            prompts.push(input.prompt)
            return { text: JSON.stringify({ decision: "escalate", reason: "Fixture requires user review" }) }
          }),
      },
    },
  })
  const request = {
    sessionID: session.id,
    action: "shell",
    resources: ["ssh node-a 'service-x --version'"],
    save: ["ssh *"],
    metadata: { command: "ssh node-a 'service-x --version'" },
  }
  return { host, permission, session, request, prompts, client: host.rpc(Contract) }
})

it.live("Allow Session records only the server's pending request and still reviews later requests", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const pending = yield* test.permission.ask(test.request)
    if (pending.effect !== "ask") throw new Error("Expected pending fixture")
    const approval = yield* test.client.allowSession({ sessionID: test.session.id, requestID: pending.id })
    expect(approval).toMatchObject({
      requestID: pending.id,
      sessionID: test.session.id,
      action: "shell",
      resources: test.request.resources,
      metadata: test.request.metadata,
    })
    expect(yield* test.permission.get(pending.id)).toBeUndefined()
    expect(yield* test.client.approvals({ sessionID: test.session.id })).toEqual([approval])
    const saved = yield* PermissionSaved.Service
    expect(yield* saved.list()).toEqual([])
    const plugins = yield* Plugin.Service
    const reopened = yield* PluginHost.make(plugins, reviewer.id)
    expect(yield* reopened.storage.get(`approval/${test.session.id}/${pending.id}`)).toEqual(approval)
    yield* test.client.set({ sessionID: test.session.id, mode: "auto" })
    expect((yield* test.permission.ask(test.request)).effect).toBe("ask")
    expect(test.prompts).toHaveLength(1)
    const evidence = JSON.parse(test.prompts[0].split("Evidence (JSON):\n")[1])
    expect(evidence.sessionApprovals).toEqual([approval])
    expect(test.prompts[0]).toContain("Later user restrictions override earlier approvals")
    yield* test.client.revoke({ sessionID: test.session.id, requestID: pending.id })
    expect(yield* test.client.approvals({ sessionID: test.session.id })).toEqual([])
    yield* test.permission.ask(test.request)
    expect(test.prompts[1]).not.toContain('"sessionApprovals"')
    yield* test.permission.close
  }),
)

it.live("ordinary replies, model assessments, stale and foreign requests cannot create remembered approvals", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const other = yield* test.host.session.create({
      title: "Other session",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    })
    const pending = yield* test.permission.ask(test.request)
    if (pending.effect !== "ask") throw new Error("Expected pending fixture")
    expect(
      Exit.isFailure(yield* test.client.allowSession({ sessionID: other.id, requestID: pending.id }).pipe(Effect.exit)),
    ).toBe(true)
    expect(yield* test.client.approvals({ sessionID: other.id })).toEqual([])
    yield* test.permission.reply({ requestID: pending.id, reply: "once" })
    expect(
      Exit.isFailure(
        yield* test.client.allowSession({ sessionID: test.session.id, requestID: pending.id }).pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(yield* test.client.approvals({ sessionID: test.session.id })).toEqual([])
    yield* test.client.set({ sessionID: test.session.id, mode: "auto" })
    yield* test.permission.ask(test.request)
    expect(yield* test.client.approvals({ sessionID: test.session.id })).toEqual([])
    yield* test.permission.close
  }),
)

it.live("remembered examples stay session-local and configured denials still win", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const pending = yield* test.permission.ask(test.request)
    if (pending.effect !== "ask") throw new Error("Expected pending fixture")
    yield* test.client.allowSession({ sessionID: test.session.id, requestID: pending.id })
    const child = yield* test.host.session.create({
      title: "Child session",
      parentID: test.session.id,
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    })
    yield* test.client.set({ sessionID: child.id, mode: "auto" })
    yield* test.permission.ask({ ...test.request, sessionID: child.id })
    expect(test.prompts[0]).not.toContain('"sessionApprovals"')
    expect(yield* test.client.approvals({ sessionID: child.id })).toEqual([])
    yield* test.host.session.update({
      sessionID: test.session.id,
      permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    })
    yield* test.client.set({ sessionID: test.session.id, mode: "auto" })
    expect((yield* test.permission.ask(test.request)).effect).toBe("deny")
    expect(test.prompts).toHaveLength(1)
    yield* test.permission.close
  }),
)
