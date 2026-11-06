import { expect, test } from "bun:test"
import { InputRenderable, BoxRenderable } from "@opentui/core"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { Schema } from "effect"
import { Contract, SessionApproval } from "./contract"
import { selectPermissionRow } from "./navigation.fixture"
import { settingsFixture } from "./settings.fixture"

async function openPermissions(setup: Awaited<ReturnType<typeof createAppFixture>>) {
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await setup.mockInput.typeText("Permissions")
  await setup.waitForFrame((frame) => frame.includes("Choose permissions"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Read only") &&
      frame.includes("Settings") &&
      setup.renderer.currentFocusedRenderable instanceof BoxRenderable,
  )
}

async function choose(setup: Awaited<ReturnType<typeof createAppFixture>>, text: string, result: string) {
  await setup.waitForFrame(
    (frame) => !frame.includes("Loading…") && setup.renderer.currentFocusedRenderable instanceof BoxRenderable,
  )
  const row = await selectPermissionRow(setup, text)
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes(result) && (row.isDestroyed || result === "Turn off auto accept") && !frame.includes("Loading…"),
  )
}

test.each([false, true])("home settings stay session-free and preset respects autoaccept=%s", async (autoaccept) => {
  const data = settingsFixture()
  const created: unknown[] = []
  const changes: unknown[] = []
  const session = {
    id: "ses_settings_home",
    title: "Settings",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    width: 112,
    height: 36,
    config: {
      animations: false,
      tabs: { enabled: false },
      session: { permissions: autoaccept ? "autoaccept" : "prompt" },
      plugins: [import.meta.dir],
    },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session" && request.method === "POST") {
        created.push(await request.json())
        return json({ data: session })
      }
      if (url.pathname === "/api/session") return json({ data: created.length ? [session] : [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message` || url.pathname === `/api/session/${session.id}/inbox`)
        return json({ data: [], cursor: {} })
      if (url.pathname.endsWith("/settings")) return json({ output: data.snapshot() })
      if (url.pathname.endsWith("/session")) return json({ output: data.fixture.session })
      if (url.pathname.endsWith("/setSession")) {
        const body = Schema.decodeUnknownSync(Schema.Struct({ input: Contract.methods.setSession.input }))(
          await request.json(),
        )
        changes.push(body.input)
        return json({ output: await data.actions.change(body.input.change) })
      }
    },
  })
  await setup.ready
  await openPermissions(setup)
  await choose(setup, "Settings", "Permission settings")
  await choose(setup, "Classifier", "Confidence")
  expect(created).toEqual([])
  data.fixture.overrides = { minConfidence: 0.87 }
  setup.events.emit({
    id: "evt_settings",
    type: "rpc.opencode.permission-review.settingsChanged",
    created: 1,
    location: { directory },
    data: {},
  })
  await setup.waitForFrame((frame) => frame.includes("0.87"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Permission settings"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("Read only") && frame.includes("Settings"))
  await choose(setup, "Read only", autoaccept ? "Turn off auto accept" : "permissions: Read only")
  expect(created).toHaveLength(autoaccept ? 0 : 1)
  expect(changes).toHaveLength(autoaccept ? 0 : 1)
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
      if (url.pathname === "/api/rpc/opencode.permission-review/settings")
        return json({ output: settingsFixture().snapshot() })
      if (url.pathname === "/api/rpc/opencode.permission-review/session")
        return json({
          output: {
            preset: "auto",
            mode: "auto",
            modeSource: "session",
            fallbackSource: "default",
            model: { providerID: "test", id: "reviewer" },
          },
        })
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
  await openPermissions(setup)
  await choose(setup, "Settings", "Permission settings")
  await choose(setup, "Activity", "Activity")
  await choose(setup, "Remembered approvals", "Remembered approvals")
  await choose(setup, "shell", "Remembered approval")
  await choose(setup, "Revoke approval", "No entries.")
  expect(remembered).toEqual([])
  expect(requests).toHaveLength(2)
  for (let index = 0; index < 5; index++) {
    setup.mockInput.pressEscape()
    await setup.renderOnce()
  }
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
