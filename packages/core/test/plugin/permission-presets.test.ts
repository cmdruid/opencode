import { expect } from "bun:test"
import { Database } from "@opencode/core/database/database"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Rpc } from "@opencode/core/rpc"
import { ProjectTable } from "@opencode/core/project/sql"
import { Model } from "@opencode/schema/model"
import { Effect, Schedule, Schema } from "effect"
import path from "node:path"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { testEffect } from "../lib/effect"
import { addUserTask, makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer(null))

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const permission = yield* Permission.Service
  const host = yield* PluginHost.make(plugins, reviewer.id)
  const session = yield* host.session.create({
    title: "Permission presets",
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  yield* addUserTask(session.id, "Inspect this checkout and run its tests")
  const calls: string[] = []
  yield* reviewer.effect({
    ...host,
    options: { model: Model.Ref.parse("test/reviewer"), defaultMode: "manual", actions: ["shell"] },
    experimental: {
      ...host.experimental,
      generate: {
        ...host.experimental.generate,
        text: (input) =>
          Effect.sync(() => {
            calls.push(input.prompt)
            return { text: JSON.stringify({ decision: "approve", reason: "Fixture approval" }) }
          }),
      },
    },
  })
  return { host, session, permission, calls, client: host.rpc(Contract) }
})

for (const preset of ["configured", "read-only", "workspace", "auto", "shadow", "full"] as const) {
  it.live(`${preset} evaluates real permissions without running tools or calling a reviewer for probes`, () =>
    Effect.gen(function* () {
      const test = yield* setup
      if (preset === "configured" || preset === "shadow")
        yield* test.host.storage.set(`selection/${test.session.id}`, {
          preset,
          mode: preset === "shadow" ? "shadow" : "manual",
        })
      else yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset } })
      expect(Schema.is(Schema.Json)(yield* test.client.session({ sessionID: test.session.id }))).toBe(true)
      for (const item of [
        { action: "read", resources: ["README.md"], expected: true },
        { action: "read", resources: [path.join(test.host.location.directory, "README.md")], expected: true },
        { action: "glob", resources: ["**/*.ts"], expected: true },
        { action: "grep", resources: ["TODO"], expected: true },
        { action: "edit", resources: ["src/index.ts"], expected: preset !== "read-only" },
        { action: "read", resources: ["../outside.txt"], expected: false },
        { action: "edit", resources: ["ok.ts", "../outside.txt"], expected: false },
        { action: "external_directory", resources: ["/tmp"], expected: false },
        { action: "shell", resources: ["bun test"], expected: false },
        { action: "shell", resources: ["rm -rf /", "git reset --hard", "git clean -fdx"], expected: false },
        { action: "webfetch", resources: ["https://example.com"], expected: false },
        { action: "websearch", resources: ["example"], expected: false },
        { action: "subagent", resources: ["general"], expected: false },
        { action: "some_mcp_tool", resources: ["*"], expected: false },
      ]) {
        const allowed = yield* test.permission.allows({
          sessionID: test.session.id,
          action: item.action,
          resources: item.resources,
        })
        expect({ action: item.action, resources: item.resources, allowed }).toEqual({
          action: item.action,
          resources: item.resources,
          allowed: preset === "configured" || preset === "full" || item.expected,
        })
      }
      expect(test.calls).toHaveLength(0)
    }),
  )
}

it.live("manual, automatic and shadow presets route actual requests; switching leaves existing prompts alone", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const request = { sessionID: test.session.id, action: "shell", resources: ["bun test"], save: ["*"] }
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "workspace" } })
    const manual = yield* test.permission.ask(request)
    expect(manual.effect).toBe("ask")
    expect(test.calls).toHaveLength(0)
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "auto" } })
    expect((yield* test.permission.ask(request)).effect).toBe("allow")
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "reviewer", mode: "shadow" } })
    const shadow = yield* test.permission.ask(request)
    expect(shadow.effect).toBe("ask")
    expect((yield* test.permission.get(shadow.id))?.message).toContain("Review: Approve · Shadow")
    expect(test.calls).toHaveLength(2)
    // An action excluded from model review still requires the human's approval.
    expect((yield* test.permission.ask({ ...request, action: "edit", resources: ["../outside"] })).effect).toBe("ask")
    expect(test.calls).toHaveLength(2)
    const saved = yield* PermissionSaved.Service
    expect(yield* saved.list()).toHaveLength(0)
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "full" } })
    expect((yield* test.permission.ask(request)).effect).toBe("allow")
    expect(yield* test.permission.get(manual.id)).toBeDefined()
    expect(yield* test.permission.get(shadow.id)).toBeDefined()
    yield* test.permission.close
  }),
)

it.live("configured denials survive full access and saved grants cannot bypass a restrictive preset", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const saved = yield* PermissionSaved.Service
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({
        id: test.host.location.project.id,
        worktree: test.host.location.directory,
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
    yield* saved.add({ projectID: test.host.location.project.id, action: "shell", resources: ["*"] })
    yield* test.host.session.update({
      sessionID: test.session.id,
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "git push *", effect: "deny" },
        { action: "read", resource: "*.env", effect: "ask" },
      ],
    })
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "workspace" } })
    expect(
      (yield* test.permission.ask({ sessionID: test.session.id, action: "read", resources: ["secrets.env"] })).effect,
    ).toBe("ask")
    expect(
      (yield* test.permission.ask({ sessionID: test.session.id, action: "shell", resources: ["git clean -fdx"] }))
        .effect,
    ).toBe("ask")
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "full" } })
    expect(
      (yield* test.permission.ask({ sessionID: test.session.id, action: "shell", resources: ["git push origin dev"] }))
        .effect,
    ).toBe("deny")
    expect((yield* saved.list()).map((rule) => rule.resource)).toEqual(["*"])
    yield* test.permission.close
  }),
)

it.live("all presets preserve effective asks and denials; only review can approve an ask once", () =>
  Effect.gen(function* () {
    const test = yield* setup
    yield* test.host.session.update({
      sessionID: test.session.id,
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "shell", resource: "deploy *", effect: "ask" },
        { action: "shell", resource: "git push *", effect: "deny" },
      ],
    })
    for (const preset of ["configured", "read-only", "workspace", "auto", "shadow", "full"] as const) {
      if (preset === "configured" || preset === "shadow")
        yield* test.host.storage.set(`selection/${test.session.id}`, {
          preset,
          mode: preset === "shadow" ? "shadow" : "manual",
        })
      else yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset } })
      const before = test.calls.length
      const request = { sessionID: test.session.id, action: "shell", resources: ["deploy production"] }
      expect(yield* test.permission.allows(request)).toBe(false)
      expect(test.calls).toHaveLength(before)
      expect((yield* test.permission.ask({ ...request, action: "read", resources: ["secrets.env"] })).effect).toBe(
        "ask",
      )
      expect((yield* test.permission.ask({ ...request, resources: ["git push origin dev"] })).effect).toBe("deny")
      expect(test.calls).toHaveLength(before)
      expect((yield* test.permission.ask(request)).effect).toBe(preset === "auto" ? "allow" : "ask")
      expect(test.calls).toHaveLength(before + (preset === "auto" || preset === "shadow" ? 1 : 0))
    }
    const saved = yield* PermissionSaved.Service
    expect(yield* saved.list()).toHaveLength(0)
    yield* test.permission.close
  }),
)

it.live("changing the reviewer preserves the selected scope, including Shadow testing", () =>
  Effect.gen(function* () {
    const test = yield* setup
    for (const preset of ["read-only", "workspace", "full"] as const) {
      yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset } })
      for (const mode of ["shadow", "auto", "manual"] as const) {
        const next = yield* test.client.setSession({ sessionID: test.session.id, change: { type: "reviewer", mode } })
        expect(next).toMatchObject({
          preset,
          mode,
        })
        expect(
          yield* test.permission.allows({ sessionID: test.session.id, action: "edit", resources: ["index.ts"] }),
        ).toBe(preset !== "read-only")
        expect(
          yield* test.permission.allows({ sessionID: test.session.id, action: "shell", resources: ["bun test"] }),
        ).toBe(preset === "full")
      }
    }
    expect(test.calls).toHaveLength(0)
  }),
)

it.live("presets persist, inherit through subagents, isolate unrelated sessions and reset to configured behavior", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const child = yield* test.host.session.create({ parentID: test.session.id })
    const grandchild = yield* test.host.session.create({ parentID: child.id })
    const other = yield* test.host.session.create({ title: "Unrelated" })
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "preset", preset: "read-only" } })
    expect(Schema.is(Schema.Json)(yield* test.client.session({ sessionID: grandchild.id }))).toBe(true)
    expect(yield* test.client.session({ sessionID: grandchild.id })).toMatchObject({
      preset: "read-only",
      mode: "manual",
      inheritedFrom: test.session.id,
    })
    expect(yield* test.permission.allows({ sessionID: grandchild.id, action: "edit", resources: ["index.ts"] })).toBe(
      false,
    )
    expect((yield* test.client.session({ sessionID: other.id })).preset).toBe("configured")
    const plugins = yield* Plugin.Service
    const reopened = yield* PluginHost.make(plugins, reviewer.id)
    expect(yield* reopened.storage.get(`selection/${test.session.id}`)).toEqual({ preset: "read-only", mode: "manual" })
    yield* test.client.setSession({ sessionID: child.id, change: { type: "preset", preset: "workspace" } })
    expect(yield* test.client.session({ sessionID: grandchild.id })).toMatchObject({
      preset: "workspace",
      inheritedFrom: child.id,
    })
    yield* test.client.setSession({ sessionID: test.session.id, change: { type: "reset", target: "selection" } })
    expect(
      yield* test.permission.allows({ sessionID: test.session.id, action: "shell", resources: ["rm -rf /"] }),
    ).toBe(true)
    expect((yield* test.client.session({ sessionID: child.id })).preset).toBe("workspace")
    const rpc = yield* Rpc.Service
    expect(
      yield* rpc
        .call(Contract.id, "setSession", { sessionID: child.id, change: { type: "preset", preset: "typo" } })
        .pipe(Effect.flip),
    ).toMatchObject({ type: "rpc.invalid_input" })
    yield* test.host.storage.set(`selection/${test.session.id}`, "invalid")
    expect(yield* test.client.session({ sessionID: test.session.id })).toMatchObject({
      preset: "read-only",
      mode: "manual",
    })
  }),
)

it.live("fast rules respect explicit denials, manual and shadow modes and never call a model", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const permission = yield* Permission.Service
    const host = yield* PluginHost.make(plugins, reviewer.id)
    const session = yield* host.session.create({
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "skill", resource: "blocked", effect: "deny" },
        { action: "read", resource: "blocked.txt", effect: "deny" },
      ],
    })
    let calls = 0
    yield* reviewer.effect({
      ...host,
      options: { model: Model.Ref.parse("missing/model"), mode: "chat", defaultMode: "auto" },
      experimental: {
        ...host.experimental,
        generate: {
          ...host.experimental.generate,
          text: () =>
            Effect.sync(() => {
              calls++
              return { text: '{"decision":"escalate","reason":"Fixture"}' }
            }),
        },
      },
    })
    yield* Effect.promise(() => Bun.write(path.join(host.location.directory, "allowed.txt"), "fixture"))
    yield* Effect.promise(() => Bun.write(path.join(host.location.directory, "blocked.txt"), "fixture"))
    for (const request of [
      { action: "skill", resources: ["tracker"] },
      { action: "todowrite", resources: ["*"] },
      { action: "read", resources: ["allowed.txt"] },
    ])
      expect((yield* permission.ask({ ...request, sessionID: session.id })).effect).toBe("allow")
    for (const request of [
      { action: "skill", resources: ["blocked"] },
      { action: "read", resources: ["blocked.txt"] },
    ])
      expect((yield* permission.ask({ ...request, sessionID: session.id })).effect).toBe("deny")
    const client = host.rpc(Contract)
    expect((yield* client.history({ sessionID: session.id })).map((item) => item.path)).toContain("tool-rule")
    for (const mode of ["shadow", "manual"] as const) {
      yield* client.setSession({
        sessionID: session.id,
        change: { type: "fallback", mode: mode === "manual" ? "off" : mode },
      })
      const pending = yield* permission.ask({ sessionID: session.id, action: "skill", resources: ["tracker"] })
      expect(pending.effect).toBe("ask")
      if (pending.effect !== "ask") throw new Error("Expected pending fixture")
      yield* permission.reply({ requestID: pending.id, reply: "once" })
      if (mode === "shadow") {
        const records = yield* client.history({ sessionID: session.id }).pipe(
          Effect.repeat({
            while: (records) => !records.find((record) => record.requestID === pending.id)?.reply,
            schedule: Schedule.spaced("5 millis"),
          }),
          Effect.timeout("2 seconds"),
        )
        expect(records.find((record) => record.requestID === pending.id)?.reply?.decision).toBe("once")
      }
    }
    expect(calls).toBe(0)
  }),
)
