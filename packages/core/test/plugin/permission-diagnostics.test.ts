import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { capture, diagnostics, retention, sanitize } from "../../../plugins/permission-review/diagnostics"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const sessionID = SessionID.create()
const entry = {
  requestID: "fixture",
  sessionID,
  action: "shell",
  model: Model.Ref.parse("test/model"),
  mode: "chat" as const,
  decision: "escalate" as const,
  shadow: false,
  at: 0,
  durationMs: 10,
  reason: "Missing scope.",
}
it.effect("captures successful, failed and interrupted calls without modifying model input", () =>
  Effect.gen(function* () {
    const trace = capture()
    const input = { prompt: "Authorization: Bearer abc123" }
    expect(yield* trace.run("reviewer", input, Effect.succeed({ text: "fixture" }))).toEqual({ text: "fixture" })
    yield* trace.run("reviewer", input, Effect.fail(new Error("api_key=secretvalue"))).pipe(Effect.exit)
    const fiber = yield* trace.run("classifier", input, Effect.never).pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust(100)
    yield* Fiber.interrupt(fiber)
    expect(trace.calls).toHaveLength(3)
    expect(trace.calls[2].durationMs).toBe(100)
    expect(trace.calls[2].payload).toMatchObject({ status: "failed" })
    expect(JSON.stringify(trace.calls)).not.toContain("secretvalue")
    expect(JSON.stringify(trace.calls)).not.toContain("abc123")
    expect(trace.calls.every((call) => call.redacted)).toBe(true)
    expect(input.prompt).toBe("Authorization: Bearer abc123")
  }),
)
it.effect("rolling history migrates, serializes concurrent writes, records replies and expires globally", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "diagnostic-count")
    yield* host.storage.set("review/legacy", { ...entry, requestID: "legacy" })
    const log = diagnostics(host.storage)
    expect((yield* log.list(sessionID))[0].requestID).toBe("legacy")
    yield* Effect.forEach(
      Array.from({ length: 505 }, (_, i) => i),
      (i) => log.put({ ...entry, requestID: String(i).padStart(4, "0") }),
      { concurrency: 8 },
    )
    expect(yield* log.list(sessionID, 1000)).toHaveLength(retention.count)
    expect((yield* host.storage.scan({ prefix: "review/", limit: 1000 })).entries).toHaveLength(retention.count)
    yield* log.reply("0504", "once")
    expect((yield* log.list(sessionID)).find((item) => item.requestID === "0504")?.reply).toEqual({
      decision: "once",
      at: 0,
    })
    yield* TestClock.adjust(retention.ageMs + 1)
    yield* log.sweep
    expect(yield* log.list(sessionID)).toEqual([])
    expect((yield* host.storage.scan({ prefix: "review/" })).entries).toEqual([])
  }),
)
it.effect("byte bounds and redaction apply to stored and exported diagnostic copies", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "diagnostic-bytes")
    const log = diagnostics(host.storage)
    const payload = { blocks: Array.from({ length: 4 }, () => "x".repeat(60_000)) }
    yield* Effect.forEach(
      Array.from({ length: 100 }, (_, i) => i),
      (i) => log.put({ ...entry, requestID: String(i), diagnostics: payload }),
    )
    const records = (yield* host.storage.scan({ prefix: "review/", limit: 1000 })).entries
    expect(records.length).toBeLessThan(100)
    expect(
      records.reduce((sum, item) => sum + new TextEncoder().encode(JSON.stringify(item.value)).byteLength, 0) +
        new TextEncoder().encode(JSON.stringify(yield* host.storage.get("diagnostics/index"))).byteLength,
    ).toBeLessThanOrEqual(retention.bytes)
    yield* log.put({
      ...entry,
      requestID: "oversize",
      diagnostics: { blocks: Array.from({ length: 20 }, () => "x".repeat(60_000)) },
    })
    expect(JSON.stringify(yield* host.storage.get("review/oversize")).length).toBeLessThan(retention.recordBytes)
    const secret = {
      password: "private",
      input: "curl -H 'Authorization: Bearer abc123' https://user:pass@example.com?api_key=abc",
      output: "sk-abcdefghijklmnopqrstuv",
    }
    const clean = sanitize(secret)
    expect(clean.redacted).toBe(true)
    expect(JSON.stringify(clean.value)).not.toContain("abc123")
    expect(JSON.stringify(clean.value)).not.toContain("user:pass")
    expect(secret.password).toBe("private")
    yield* log.put({ ...entry, requestID: "secret", diagnostics: secret })
    expect(JSON.stringify(yield* log.list(sessionID, 500))).not.toContain("abcdefghijklmnopqrstuv")
  }),
)
