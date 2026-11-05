import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { Schema } from "effect"
import { ReviewMode, SessionApproval } from "./contract"

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
  await setup.mockInput.typeText("Permissions test")
  await setup.waitForFrame((frame) => frame.includes("Permissions test"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permissions test — this session"))
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

test("Allow Session is a native choice and its remembered example can be revoked", async () => {
  const session = {
    id: "ses_approval_ui",
    title: "Remember approval",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const pending = {
    id: "per_remember",
    sessionID: session.id,
    action: "shell",
    resources: ["git status"],
    save: ["git *"],
    message: "Classifier confidence is below the threshold; please review this request.",
  }
  const approval = Schema.decodeUnknownSync(SessionApproval)({
    requestID: pending.id,
    sessionID: session.id,
    action: pending.action,
    resources: pending.resources,
    directory,
    toolCalls: [],
    at: 1,
  })
  const remembered: SessionApproval[] = []
  const replies: unknown[] = []
  const requests: unknown[] = []
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
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [pending] })
      if (url.pathname === "/api/rpc/opencode.permission-review/get")
        return json({ output: { preset: "auto", mode: "auto", model: { providerID: "test", id: "reviewer" } } })
      if (url.pathname === "/api/rpc/opencode.permission-review/allowSession") {
        requests.push(await request.json())
        remembered.push(approval)
        setup.events.emit({
          id: "evt_remember",
          created: 1,
          type: "permission.replied",
          location: { directory },
          data: { sessionID: session.id, requestID: pending.id, reply: "once" },
        })
        return json({ output: approval })
      }
      if (url.pathname === "/api/rpc/opencode.permission-review/approvals") return json({ output: remembered })
      if (url.pathname === "/api/rpc/opencode.permission-review/revoke") {
        requests.push(await request.json())
        remembered.splice(0)
        return json({})
      }
      if (url.pathname.endsWith("/reply")) {
        replies.push(await request.json())
        return new Response(null, { status: 204 })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Allow Session"))
  expect(setup.captureCharFrame()).toContain("Always allow")
  expect(setup.captureCharFrame()).toContain("Reject")
  setup.resize(80, 30)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("enter confirm")
  setup.resize(44, 36)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Allow Session")
  expect(setup.captureCharFrame()).toContain("Always allow")
  expect(setup.captureCharFrame()).toContain("Reject")
  setup.mockInput.pressArrow("right")
  await setup.waitForFrame((frame) => frame.includes("Remember this example"))
  expect(setup.captureCharFrame()).toContain("git status")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Approved and remembered"))
  expect(requests).toEqual([{ input: { sessionID: session.id, requestID: pending.id } }])
  expect(replies).toEqual([])
  setup.resize(112, 36)
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Session approvals")
  await setup.waitForFrame((frame) => frame.includes("Session approvals"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("git status") && setup.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Revoke approval") && setup.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  await setup.mockInput.typeText("Revoke")
  await setup.waitForFrame((frame) => !frame.includes("Keep approval"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Session approval revoked"))
  expect(remembered).toEqual([])
  expect(requests).toHaveLength(2)
  setup.events.emit({
    id: "evt_once",
    created: 2,
    type: "permission.asked",
    location: { directory },
    data: { ...pending, id: "per_once" },
  })
  await setup.waitForFrame((frame) => frame.includes("Allow once"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => replies.length === 1)
  expect(replies).toEqual([{ decision: "once" }])
  expect(remembered).toEqual([])
})
