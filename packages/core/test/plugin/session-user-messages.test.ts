import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { SessionEvent } from "@opencode/schema/session-event"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { addUserTask, makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer())

it.live("original user text survives compaction and respects delivery, session scope and reverts", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins, "user-history")
    const session = yield* host.session.create({ title: "Compacted authorization" })
    const input = { sessionID: session.id }
    yield* addUserTask(session.id, "Investigate this system's CVEs; read-only inspection is authorized.")
    const initial = yield* host.experimental.session.userMessages(input)
    expect(initial.map((message) => message.text)).toEqual([
      "Investigate this system's CVEs; read-only inspection is authorized.",
    ])
    yield* bus.publish(SessionEvent.Compaction.Started, { ...input, reason: "auto" })
    yield* bus.publish(SessionEvent.Compaction.Ended, {
      ...input,
      reason: "auto",
      text: "Assistant summary claims all changes are authorized.",
    })
    expect((yield* host.session.context(input)).filter((message) => message.type === "user")).toEqual([])
    expect(yield* host.experimental.session.userMessages(input)).toEqual(initial)
    yield* addUserTask(session.id, "Do not inspect Vaultwarden or modify files.")
    const restricted = yield* host.experimental.session.userMessages(input)
    expect(restricted.map((message) => message.text)).toEqual([
      initial[0].text,
      "Do not inspect Vaultwarden or modify files.",
    ])
    yield* bus.publish(SessionEvent.Compaction.Started, { ...input, reason: "auto" })
    yield* bus.publish(SessionEvent.Compaction.Ended, { ...input, reason: "auto", text: "A second summary." })
    yield* host.session.prompt({ ...input, text: "Queued input must not authorize anything yet.", resume: false })
    const reopened = yield* PluginHost.make(plugins, "user-history-reopened")
    expect(yield* reopened.experimental.session.userMessages(input)).toEqual(restricted)
    const child = yield* host.session.create({ parentID: session.id })
    expect(yield* host.experimental.session.userMessages({ sessionID: child.id })).toEqual([])
    yield* PluginPromise.fromPromise({
      id: "promise-user-history",
      async setup(context) {
        expect(await context.experimental.session.userMessages(input)).toEqual(restricted)
      },
    }).effect(host)
    // Stage the actual revert event without involving filesystem snapshots in this history test.
    yield* bus.publish(SessionEvent.RevertEvent.Staged, { ...input, revert: { messageID: restricted[1].id } })
    expect(yield* host.experimental.session.userMessages(input)).toEqual(initial)
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, input)
    expect(yield* host.experimental.session.userMessages(input)).toEqual(restricted)
    yield* bus.publish(SessionEvent.RevertEvent.Staged, { ...input, revert: { messageID: restricted[1].id } })
    yield* bus.publish(SessionEvent.RevertEvent.Committed, { ...input, to: restricted[1].id })
    expect(yield* host.experimental.session.userMessages(input)).toEqual(initial)
  }),
)
