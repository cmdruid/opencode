import { createSignal } from "solid-js"
import { Schema } from "effect"
import { Assessment, SessionApproval } from "./contract"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../tui/src/theme/assets/v2/opencode2.json"
import { PermissionSettings } from "./settings-ui"
import { settingsFixture } from "./settings.fixture"

async function fixture(width = 112) {
  const data = settingsFixture()
  const closed = { value: false }
  const [revision, setRevision] = createSignal(0)
  const app = await testRender(
    () => (
      <PermissionSettings
        theme={resolveThemeDocument(parseThemeDocument(themeSource), "dark")}
        actions={data.actions}
        revision={revision()}
        onClose={() => {
          closed.value = true
        }}
      />
    ),
    { width, height: 36, kittyKeyboard: true },
  )
  const ready = async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
      await app.renderOnce()
      if (!app.captureCharFrame().includes("Loading…")) return
    }
    throw new Error(app.captureCharFrame())
  }
  await ready()
  const open = async (name: string) => {
    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.typeText(name)
    await app.renderOnce()
    app.mockInput.pressEnter()
    await ready()
  }
  const back = async () => {
    app.mockInput.pressEscape()
    await ready()
  }
  const submit = async () => {
    app.mockInput.pressKey("s", { ctrl: true })
    await ready()
  }
  return {
    app,
    data,
    closed,
    ready,
    refresh: async () => {
      setRevision((value) => value + 1)
      await ready()
    },
    open,
    back,
    submit,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
    },
  }
}

test.each([44, 112])(
  "settings overview and long values fit at %s columns without creating a session",
  async (width) => {
    await using f = await fixture(width)
    await f.open("Settings")
    expect(f.app.captureCharFrame()).toContain("Permission settings")
    expect(f.app.captureCharFrame()).toContain("Primary reviewer")
    expect(f.data.fixture.session).toBeUndefined()
    await f.open("Primary reviewer")
    expect(f.app.captureCharFrame()).toContain("All sessions on this server")
    expect(f.app.captureCharFrame()).toContain("fixture/classifier")
    await f.back()
    expect(f.app.captureCharFrame()).toContain("Filter: Primary reviewer")
    await f.back()
    expect(f.closed.value).toBe(false)
    await f.back()
    expect(f.closed.value).toBe(true)
  },
)

test("editor preserves a failed draft, saves to its parent, and cancels without writes", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Review policy")
  await f.open("Additional instructions")
  await f.app.mockInput.typeText("Only the requested effects")
  f.data.fixture.failure = "Fixture save failed"
  await f.submit()
  expect(f.app.captureCharFrame()).toContain("Fixture save failed")
  expect(f.app.captureCharFrame()).toContain("Only the requested effects")
  expect(f.data.fixture.writes).toEqual([])
  f.data.fixture.failure = ""
  await f.submit()
  expect(f.app.captureCharFrame()).toContain("Review policy")
  expect(f.data.fixture.writes).toEqual([{ patch: { policy: "Only the requested effects" } }])
  await f.open("Additional instructions")
  await f.app.mockInput.typeText("Discard me")
  await f.back()
  expect(f.data.fixture.writes).toHaveLength(1)
  await f.open("Use configured values")
  expect(f.data.fixture.writes[1]).toEqual({ patch: {}, reset: ["defaultMode", "actions", "policy"] })
})

test("backend and model save together, second-opinion setup includes its variant", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Primary reviewer")
  await f.open("Backend")
  await f.open("Chat")
  expect(f.data.fixture.writes).toEqual([])
  await f.open("fixture/chat")
  expect(f.app.captureCharFrame()).toContain("Primary reviewer")
  expect(f.data.fixture.writes[0]).toMatchObject({
    patch: { mode: "chat", model: { providerID: "fixture", id: "chat" } },
  })
  await f.back()
  await f.open("Second opinion")
  expect(f.app.captureCharFrame()).toContain("Inactive with a chat primary")
  await f.open("Model and variant")
  await f.open("fixture/chat")
  await f.open("bounded")
  expect(f.data.fixture.writes[1]).toMatchObject({ patch: { fallback: { model: { id: "chat", variant: "bounded" } } } })
})

test("connection is a single draft; changing an endpoint cannot keep its saved key", async () => {
  await using f = await fixture()
  f.data.fixture.connection.custom = true
  f.data.fixture.connection.authenticated = true
  await f.open("Settings")
  await f.open("Primary reviewer")
  await f.open("Connection")
  await f.open("Base URL")
  await f.app.mockInput.typeText("/new")
  await f.submit()
  expect(f.data.fixture.writes).toEqual([])
  await f.open("Save connection")
  expect(f.app.captureCharFrame()).toContain("Endpoint changed")
  await f.open("Authentication")
  await f.open("No API key")
  await f.open("Save connection")
  expect(f.data.fixture.writes[0]).toMatchObject({ patch: {}, connection: { role: "classifier", apiKey: "" } })
  await f.open("Connection")
  await f.open("Authentication")
  await f.open("Set API key")
  await f.open("API key")
  await f.app.mockInput.typeText("discarded-secret")
  await f.submit()
  await f.open("Cancel")
  expect(f.data.fixture.writes).toHaveLength(1)
})

test("numeric and policy controls bind to their server fields, including all versus no actions", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Primary reviewer")
  await f.open("Confidence threshold")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("2")
  await f.submit()
  expect(f.data.fixture.writes).toHaveLength(0)
  await f.back()
  await f.back()
  await f.open("Second opinion")
  await f.open("Default mode")
  await f.open("Automatic")
  expect(f.data.fixture.writes.at(-1)?.patch.fallback).toMatchObject({ mode: "auto" })
  await f.open("Timeout (ms)")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("500")
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.fallback).toMatchObject({ timeoutMs: 500 })
  await f.open("Remove second opinion")
  expect(f.data.fixture.writes.at(-1)?.patch.fallback).toBeNull()
  await f.back()
  await f.open("Review policy")
  await f.open("Default reviewer mode")
  await f.open("Manual")
  expect(f.data.fixture.writes.at(-1)?.patch.defaultMode).toBe("manual")
  await f.open("Reviewed actions")
  await f.open("Choose action names")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.actions).toEqual([])
  await f.open("Reviewed actions")
  await f.open("All actions")
  expect(f.data.fixture.writes.at(-1)?.patch.actions).toBeNull()
  await f.open("Reviewed actions")
  await f.open("Common actions")
  await f.open("read")
  await f.open("Save actions")
  expect(f.data.fixture.writes.at(-1)?.patch.actions).not.toContain("read")
})

test("activity details return to their lists and revocation updates the local list", async () => {
  await using f = await fixture()
  await f.data.actions.change({ type: "preset", preset: "workspace" })
  f.data.fixture.history.push(
    Schema.decodeUnknownSync(Assessment)({
      requestID: "per_fixture",
      sessionID: "ses_fixture",
      action: "shell",
      resources: ["git status"],
      model: { providerID: "fixture", id: "chat" },
      mode: "chat",
      shadow: true,
      at: 1,
      durationMs: 3,
      decision: "approve",
      reason: "Read-only inspection of the requested project.",
    }),
  )
  f.data.fixture.approvals.push(
    Schema.decodeUnknownSync(SessionApproval)({
      requestID: "per_fixture",
      sessionID: "ses_fixture",
      action: "shell",
      resources: ["git status"],
      directory: "/fixture",
      toolCalls: [],
      at: 1,
    }),
  )
  await f.refresh()
  expect(f.app.captureCharFrame()).not.toContain("new session")
  await f.open("Settings")
  await f.open("Activity")
  await f.open("Review history")
  await f.open("approve")
  expect(f.app.captureCharFrame()).toContain("Shadow proposal")
  expect(f.app.captureCharFrame()).toContain("not whether the tool executed")
  await f.back()
  expect(f.app.captureCharFrame()).toContain("Review history")
  await f.back()
  await f.open("Remembered approvals")
  await f.open("shell")
  await f.open("Details")
  expect(f.app.captureCharFrame()).toContain("git status")
  await f.back()
  expect(f.app.captureCharFrame()).toContain("Remembered approvals")
  await f.open("shell")
  await f.open("Revoke approval")
  expect(f.app.captureCharFrame()).toContain("No entries.")
  expect(f.data.fixture.approvals).toEqual([])
})
