import { expect } from "bun:test"
import { Agent, Model } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { PermissionReview } from "@opencode/plugin/permission"
import { Permission } from "../../schema/src/permission"
import { SessionID } from "../../schema/src/session-id"
import { SessionMessage } from "../../schema/src/session-message"
import type { Generate } from "../../schema/src/generate"
import { AbsolutePath } from "../../schema/src/schema"
import { DateTime, Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { location } from "../../core/test/fixture/location"
import { review } from "./review.js"

const options = { model: Model.Ref.parse("test/reviewer") }
const messageID = SessionMessage.ID.create()
const event: PermissionReview = {
  request: {
    id: Permission.ID.create(),
    sessionID: SessionID.create(),
    action: "shell",
    resources: ["git status"],
    save: ["*"],
    metadata: { command: "git status", directory: "/project" },
    source: { type: "tool", messageID, id: "call_test" },
  },
}

function context(text: string, answers: Generate.DecisionAnswer[] = [], prompt = "Inspect this checkout") {
  const prompts: string[] = []
  const decisions: Generate.DecisionRequest[] = []
  const ctx = {
    location: location({ directory: AbsolutePath.make("/project") }),
    session: {
      context: () =>
        Effect.succeed([
          SessionMessage.User.make({
            id: SessionMessage.ID.create(),
            text: prompt,
            time: { created: DateTime.makeUnsafe(0) },
          }),
          SessionMessage.Assistant.make({
            id: messageID,
            agent: Agent.ID.make("build"),
            model: options.model,
            time: { created: DateTime.makeUnsafe(0) },
            content: [
              {
                type: "tool",
                id: "call_test",
                name: "shell",
                state: { status: "running", input: { command: "git status" }, metadata: {} },
                time: { created: DateTime.makeUnsafe(0) },
              },
            ],
          }),
        ]),
    },
    experimental: {
      generate: {
        text: (input) =>
          Effect.sync(() => {
            prompts.push(input.prompt)
            return { text }
          }),
        decisions: (input) =>
          Effect.sync(() => {
            decisions.push(input)
            return { answers }
          }),
        image: () => Effect.die("Reviewer must not generate images"),
      },
    },
  } satisfies {
    location: Plugin.Context["location"]
    session: Pick<Plugin.Context["session"], "context">
    experimental: Pick<Plugin.Context["experimental"], "generate">
  }
  return { ctx, prompts, decisions }
}

it.effect("chat review supplies exact action and user evidence and accepts all three outcomes", () =>
  Effect.gen(function* () {
    for (const decision of ["approve", "deny", "escalate"] as const) {
      const fixture = context(JSON.stringify({ decision, reason: "Policy assessment" }))
      expect(yield* review(fixture.ctx, event, options)).toEqual({ decision, reason: "Policy assessment" })
      expect(fixture.prompts[0]).toContain("Inspect this checkout")
      expect(fixture.prompts[0]).toContain('"command":"git status"')
      expect(fixture.prompts[0]).not.toContain('"save":')
      expect(fixture.prompts[0]).toContain('"toolCalls":[{"name":"shell","input":{"command":"git status"}}]')
      expect(fixture.decisions).toEqual([])
    }
  }),
)

it.effect("malformed chat responses escalate instead of granting permission", () =>
  Effect.gen(function* () {
    for (const text of ['{"decision":"approve"}', '{"decision":"always","reason":"safe"}', "yes", "{}"])
      expect((yield* review(context(text).ctx, event, options)).decision).toBe("escalate")
  }),
)

it.effect("oversized evidence escalates without truncation or a model call", () =>
  Effect.gen(function* () {
    const fixture = context("", [], "x".repeat(48_001))
    expect((yield* review(fixture.ctx, event, options)).decision).toBe("escalate")
    expect(fixture.prompts).toEqual([])
    expect(fixture.decisions).toEqual([])
  }),
)

it.effect("decision models use confidence only as a routing threshold", () =>
  Effect.gen(function* () {
    for (const confidence of [0.99, 0.98, 0.4]) {
      const fixture = context("", [
        {
          type: "choice",
          name: "permission",
          choice: "approve",
          confidence,
          probabilities: [{ value: "approve", probability: confidence }],
        },
      ])
      const result = yield* review(fixture.ctx, event, { ...options, mode: "decision" })
      expect(result).toMatchObject({
        decision: confidence >= 0.98 ? "approve" : "escalate",
        classifier: {
          choice: "approve",
          confidence,
          probabilities: [{ value: "approve", probability: confidence }],
          threshold: 0.98,
        },
      })
      if (confidence < 0.98) expect(result.reason).toContain(`confidence ${confidence}, required 0.98`)
      expect(fixture.prompts).toEqual([])
      expect(fixture.decisions[0].questions[0]).toMatchObject({ type: "choice", name: "permission" })
      expect(fixture.decisions[0].input).toEqual([
        expect.objectContaining({ text: expect.stringContaining('"command":"git status"') }),
      ])
      expect(fixture.decisions[0].input).toEqual([
        expect.objectContaining({ text: expect.not.stringContaining('"save":') }),
      ])
      expect(event.request.save).toEqual(["*"])
    }
    const fixture = context("", [{ type: "error", name: "permission", reason: "refused" }])
    expect((yield* review(fixture.ctx, event, { ...options, mode: "decision" })).decision).toBe("escalate")
  }),
)

it.effect("classifier diagnostics preserve unsupported choices without authorizing them", () =>
  Effect.gen(function* () {
    const fixture = context("", [
      { type: "choice", name: "permission", choice: "always", confidence: 1, probabilities: [] },
    ])
    expect(yield* review(fixture.ctx, event, { ...options, mode: "decision", minConfidence: 0.9 })).toMatchObject({
      decision: "escalate",
      classifier: { choice: "always", confidence: 1, threshold: 0.9 },
    })
  }),
)
