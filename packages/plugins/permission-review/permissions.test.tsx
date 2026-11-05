import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { Schema } from "effect"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { Preset, type ReviewMode } from "./contract"

async function fixture(options: { auto?: boolean; autoaccept?: boolean; fail?: boolean } = {}) {
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
  const state = {
    preset: "configured" as Preset,
    mode: "manual" as ReviewMode,
    model: { providerID: "test", id: "reviewer" },
  }
  const setup = await createAppFixture({
    width: 112,
    height: 36,
    args: { sessionID: session.id, auto: options.auto },
    config: {
      animations: false,
      tabs: { enabled: false },
      session: { permissions: options.autoaccept ? "autoaccept" : "prompt" },
      plugins: [import.meta.dir],
    },
    fetch: async (url, request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/rpc/opencode.permission-review/get") return json({ output: state })
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
  return { ...setup, updates }
}

async function open(setup: Awaited<ReturnType<typeof fixture>>) {
  await setup.mockInput.typeText("/permissions")
  await setup.waitForFrame((frame) => frame.includes("Choose permissions and approval handling"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permissions — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
}

async function choose(setup: Awaited<ReturnType<typeof fixture>>, label: string) {
  await setup.mockInput.typeText(label)
  await setup.waitForFrame((frame) => frame.includes(label))
  setup.mockInput.pressEnter()
}

test("/permissions opens the real selector, changes modes, shows the active preset and fits a narrow terminal", async () => {
  await using setup = await fixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  await open(setup)
  expect(setup.captureCharFrame()).toContain("Read only")
  expect(setup.captureCharFrame()).toContain("Ask for approval")
  expect(setup.captureCharFrame()).toContain("Approve for me")
  expect(setup.captureCharFrame()).toContain("Full access")
  setup.resize(58, 30)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Ask for approval")
  await choose(setup, "Read only")
  await setup.waitForFrame(
    (frame) => frame.includes("permissions:") && frame.includes("Read only") && !frame.includes("Permissions — this session"),
  )
  setup.resize(112, 36)
  await setup.renderOnce()
  for (const label of ["Ask for approval", "Approve for me", "Shadow"]) {
    await open(setup)
    await choose(setup, label)
    await setup.waitForFrame((frame) => frame.includes(`permissions: ${label}`))
  }
  expect(setup.updates).toEqual(["read-only", "workspace", "auto", "shadow"])
  await setup.mockInput.typeText("/permission-review")
  await setup.waitForFrame((frame) => frame.includes("Choose how this session handles requests"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Permissions — this session"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
  setup.mockInput.pressKey("i", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Active permissions"))
  expect(setup.captureCharFrame()).toContain("Preset: Shadow")
  expect(setup.captureCharFrame()).toContain("test/reviewer")
  expect(setup.captureCharFrame()).toContain("not an OS sandbox")
})

test("full access requires a second selection that defaults to cancel, and configured rules reset the preset", async () => {
  await using setup = await fixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  await open(setup)
  await choose(setup, "Full access")
  await setup.waitForFrame((frame) => frame.includes("Enable full access?"))
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
  await choose(setup, "Configured rules")
  await setup.waitForFrame((frame) => frame.includes("review: Manual"))
  expect(setup.updates).toEqual(["full", "configured"])
})

for (const options of [{ auto: true }, { autoaccept: true }]) {
  test(`auto accept from ${options.auto ? "--auto" : "settings"} prevents a misleading manual preset`, async () => {
    await using setup = await fixture(options)
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("permissions: client auto accept"))
    await open(setup)
    await choose(setup, "Ask for approval")
    await setup.waitForFrame((frame) => frame.includes("Turn off auto accept"))
    expect(setup.captureCharFrame()).toContain("restart without it")
    expect(setup.updates).toEqual([])
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
