import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { Schema } from "effect"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { Preset, type ReviewMode } from "./contract"

async function fixture(
  options: { auto?: boolean; autoaccept?: boolean; fail?: boolean; home?: boolean; createFail?: boolean } = {},
) {
  const session = {
    id: "ses_permissions_ui",
    title: "Permissions UI",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const updates: Preset[] = []
  const created: unknown[] = []
  const submissions: string[] = []
  const state = {
    preset: "configured" as Preset,
    mode: "manual" as ReviewMode,
    model: { providerID: "test", id: "reviewer" },
  }
  const setup = await createAppFixture({
    width: 112,
    height: 36,
    args: { sessionID: options.home ? undefined : session.id, auto: options.auto },
    config: {
      animations: false,
      tabs: { enabled: false },
      session: { permissions: options.autoaccept ? "autoaccept" : "prompt" },
      plugins: [import.meta.dir],
    },
    fetch: async (url, request) => {
      if (request.method === "POST" && !url.pathname.startsWith("/api/rpc/")) submissions.push(url.pathname)
      if (url.pathname === "/api/session" && request.method === "POST") {
        if (options.createFail) return new Response("Fixture session creation failure", { status: 500 })
        created.push(await request.json())
        return json({ data: session })
      }
      if (url.pathname === "/api/session")
        return json({ data: options.home && !created.length ? [] : [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/rpc/opencode.permission-review/get") return json({ output: state })
      if (url.pathname === "/api/rpc/opencode.permission-review/set") {
        expect(await request.json()).toMatchObject({ input: { sessionID: session.id, mode: "shadow" } })
        state.preset = "shadow"
        state.mode = "shadow"
        updates.push("shadow")
        setup.events.emit({
          id: "evt_shadow",
          created: updates.length,
          type: "rpc.opencode.permission-review.changed",
          location: { directory },
          data: { sessionID: session.id, state },
        })
        return json({ output: state })
      }
      if (url.pathname === "/api/rpc/opencode.permission-review/select") {
        if (options.fail) return new Response("Fixture RPC failure", { status: 500 })
        const body = Schema.decodeUnknownSync(
          Schema.Struct({ input: Schema.Struct({ sessionID: Schema.String, preset: Preset }) }),
        )(await request.json())
        expect(body.input.sessionID).toBe(session.id)
        updates.push(body.input.preset)
        state.preset = body.input.preset
        state.mode = state.preset === "auto" || state.preset === "shadow" ? state.preset : "manual"
        setup.events.emit({
          id: `evt_preset_${updates.length}`,
          created: updates.length,
          type: "rpc.opencode.permission-review.changed",
          location: { directory },
          data: { sessionID: session.id, state },
        })
        return json({ output: state })
      }
    },
  })
  return { ...setup, updates, created, submissions }
}

async function open(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await setup.mockInput.typeText("/permissions")
  await setup.waitForFrame((frame) => frame.includes("Choose permissions"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permissions — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
}

async function choose(setup: Awaited<ReturnType<typeof fixture>>, label: string) {
  await setup.mockInput.typeText(label)
  await setup.waitForFrame((frame) => frame.includes(label))
  setup.mockInput.pressEnter()
}

for (const settings of [false, true]) {
  test(`home-screen /permissions opens ${settings ? "settings" : "presets"} in one empty session`, async () => {
    await using setup = await fixture({ home: true })
    await setup.ready
    expect(setup.created).toEqual([])
    await open(setup)
    expect(setup.created).toMatchObject([{ location: { directory } }])
    if (settings) {
      await choose(setup, "Settings")
      await setup.waitForFrame((frame) => frame.includes("Permission settings — this session"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
      expect(setup.updates).toEqual([])
      await choose(setup, "Reviewer mode")
      await setup.waitForFrame((frame) => frame.includes("Reviewer mode — this session"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    }
    await choose(setup, settings ? "Shadow" : "Read only")
    await setup.waitForFrame((frame) => frame.includes(`permissions: ${settings ? "Shadow" : "Read only"}`))
    expect(setup.updates).toEqual([settings ? "shadow" : "read-only"])
    expect(setup.submissions).toEqual(["/api/session"])
    await open(setup)
    expect(setup.created).toHaveLength(1)
  })
}

test("home-screen session creation failure shows an error without opening a selector", async () => {
  await using setup = await fixture({ home: true, createFail: true })
  await setup.ready
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await setup.mockInput.typeText("/permissions")
  await setup.waitForFrame((frame) => frame.includes("Choose permissions and approval handling"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("UnexpectedStatus: 500"))
  expect(setup.captureCharFrame()).not.toContain("Permissions — this session")
  expect(setup.created).toEqual([])
  expect(setup.updates).toEqual([])
})

test("/permissions opens the real selector, changes modes, shows the active preset and fits a narrow terminal", async () => {
  await using setup = await fixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  await open(setup)
  expect(setup.captureCharFrame()).toContain("Read only")
  expect(setup.captureCharFrame()).toContain("Ask for approval")
  expect(setup.captureCharFrame()).toContain("Approve for me")
  expect(setup.captureCharFrame()).toContain("Full access")
  expect(setup.captureCharFrame()).toContain("Settings")
  expect(setup.captureCharFrame()).toContain("shell/network")
  expect(setup.captureCharFrame()).not.toContain("Configured rules")
  expect(setup.captureCharFrame()).not.toContain("Shadow")
  setup.resize(58, 30)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Ask for approval")
  await choose(setup, "Read only")
  await setup.waitForFrame(
    (frame) =>
      frame.includes("permissions:") && frame.includes("Read only") && !frame.includes("Permissions — this session"),
  )
  setup.resize(112, 36)
  await setup.renderOnce()
  for (const label of ["Ask for approval", "Approve for me"]) {
    await open(setup)
    await choose(setup, label)
    await setup.waitForFrame((frame) => frame.includes(`permissions: ${label}`))
  }
  await open(setup)
  await choose(setup, "Settings")
  await setup.waitForFrame((frame) => frame.includes("Permission settings — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await choose(setup, "Reviewer mode")
  await setup.waitForFrame((frame) => frame.includes("Reviewer mode — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await choose(setup, "Shadow")
  await setup.waitForFrame((frame) => frame.includes("permissions: Shadow"))
  expect(setup.updates).toEqual(["read-only", "workspace", "auto", "shadow"])
  await open(setup)
  setup.mockInput.pressKey("i", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Active permissions"))
  expect(setup.captureCharFrame()).toContain("Preset: Ask for approval")
  expect(setup.captureCharFrame()).toContain("Reviewer: Shadow")
  expect(setup.captureCharFrame()).toContain("test/reviewer")
  expect(setup.captureCharFrame()).toContain("not an OS sandbox")
})

test("full access requires a second selection that defaults to cancel and explains configured approval rules remain", async () => {
  await using setup = await fixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  await open(setup)
  await choose(setup, "Full access")
  await setup.waitForFrame((frame) => frame.includes("Enable full access?"))
  expect(setup.captureCharFrame()).toContain("Keep configured approval rules")
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Enable full access?"))
  expect(setup.updates).toEqual([])
  await open(setup)
  await choose(setup, "Full access")
  await setup.waitForFrame((frame) => frame.includes("Enable full access?"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("permissions: Full access"))
  expect(setup.updates).toEqual(["full"])
  await open(setup)
  expect(setup.captureCharFrame()).not.toContain("Configured rules")
  expect(setup.captureCharFrame()).toContain("Configured limits still apply")
})

for (const options of [{ auto: true }, { autoaccept: true }]) {
  test(`auto accept from ${options.auto ? "--auto" : "settings"} prevents a misleading manual preset`, async () => {
    await using setup = await fixture(options)
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("permissions: client auto accept"))
    for (const label of ["Ask for approval", "Full access"]) {
      await open(setup)
      await choose(setup, label)
      await setup.waitForFrame((frame) => frame.includes("Turn off auto accept"))
      expect(setup.captureCharFrame()).toContain("restart without it")
      expect(setup.updates).toEqual([])
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => !frame.includes("Turn off auto accept"))
    }
  })
}

test("a failed selection displays an error and keeps the previous permissions", async () => {
  await using setup = await fixture({ fail: true })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  await open(setup)
  await choose(setup, "Read only")
  await setup.waitForFrame(
    (frame) => frame.includes("Permission review") && !frame.includes("Permissions — this session"),
  )
  expect(setup.captureCharFrame()).toContain("review: Manual")
  expect(setup.updates).toEqual([])
})

test("settings can be cancelled or inspected with auto accept without changing permissions", async () => {
  await using setup = await fixture({ autoaccept: true })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("permissions: client auto accept"))
  await open(setup)
  await choose(setup, "Settings")
  await setup.waitForFrame((frame) => frame.includes("Permission settings — this session"))
  expect(setup.updates).toEqual([])
  setup.resize(58, 30)
  await setup.renderOnce()
  for (const title of ["Reviewer mode", "Session approvals", "Review history", "Active permissions"])
    expect(setup.captureCharFrame()).toContain(title)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Permission settings — this session"))
  expect(setup.updates).toEqual([])
  await open(setup)
  await choose(setup, "Settings")
  await setup.waitForFrame((frame) => frame.includes("Permission settings — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  await choose(setup, "Active permissions")
  await setup.waitForFrame((frame) => frame.includes("Reviewer: Manual"))
  expect(setup.updates).toEqual([])
})
