import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { Schema } from "effect"
import { ReviewMode } from "./contract"

test("the plugin exposes session modes and assessment details through the real TUI", async () => {
  const session = {
    id: "ses_permission_ui",
    title: "Permission review UI",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const updates: { sessionID: string; mode: ReviewMode }[] = []
  const state = {
    preset: "configured",
    mode: "shadow" as ReviewMode,
    model: { providerID: "test", id: "reviewer" },
    actions: ["read"],
  }
  await using setup = await createAppFixture({
    width: 112,
    height: 36,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { enabled: false }, plugins: [import.meta.dir] },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/rpc/opencode.permission-review/get") return json({ output: state })
      if (url.pathname === "/api/rpc/opencode.permission-review/set") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ input: Schema.Struct({ sessionID: Schema.String, mode: ReviewMode }) }),
        )(await request.json())
        updates.push(body.input)
        state.mode = body.input.mode
        setup.events.emit({
          id: "evt_review_mode",
          created: 1,
          type: "rpc.opencode.permission-review.changed",
          location: { directory },
          data: { sessionID: session.id, state },
        })
        return json({ output: state })
      }
      if (url.pathname === "/api/rpc/opencode.permission-review/history")
        return json({
          output: [
            {
              requestID: "per_ui",
              sessionID: session.id,
              action: "read",
              resources: ["README.md"],
              model: state.model,
              mode: "decision",
              shadow: true,
              at: 1,
              durationMs: 715,
              decision: "approve",
              reason: "Authorized local inspection",
              classifier: { choice: "approve", confidence: 0.9954, threshold: 0.98, probabilities: [] },
            },
          ],
        })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Shadow"))
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Permission review mode")
  await setup.waitForFrame((frame) => frame.includes("Permission review mode"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permission review — this session"))
  expect(setup.captureCharFrame()).toContain("Approve for me")
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Manual")
  await setup.waitForFrame((frame) => !frame.includes("Approve for me"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  expect(updates).toEqual([{ sessionID: session.id, mode: "manual" }])
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Permission review history")
  await setup.waitForFrame((frame) => frame.includes("Permission review history"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permission reviews — latest 50"))
  expect(setup.captureCharFrame()).toContain("README.md")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permission assessment"))
  expect(setup.captureCharFrame()).toContain("Confidence: 0.9954; threshold: 0.98")
  expect(setup.captureCharFrame()).toContain("Shadow proposal: approve")
  setup.resize(58, 30)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Permission assessment")
})
