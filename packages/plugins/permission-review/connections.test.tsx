import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { Schema } from "effect"
import { Model } from "@opencode/plugin/effect"
import { createAppFixture } from "../../tui/test/fixture/app"
import { directory, json } from "../../tui/test/fixture/tui-client"
import { ConnectionInput, type ConnectionSettings } from "./contract"

test("connection settings edit both endpoints, keep keys private in state, cancel and restore", async () => {
  const session = {
    id: "ses_connection_ui",
    title: "Connection UI",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const entries: ConnectionSettings[] = [
    {
      role: "classifier",
      model: Model.Ref.parse("test/classifier"),
      url: "http://127.0.0.1:28443/v1",
      custom: false,
      authenticated: false,
    },
    { role: "fallback", model: Model.Ref.parse("test/chat"), custom: false, authenticated: false },
  ]
  const writes: ConnectionInput[] = []
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
      if (url.pathname === "/api/rpc/opencode.permission-review/get")
        return json({ output: { preset: "auto", mode: "auto", model: { providerID: "test", id: "classifier" } } })
      if (url.pathname === "/api/rpc/opencode.permission-review/connections") return json({ output: entries })
      if (url.pathname === "/api/rpc/opencode.permission-review/setConnection") {
        const body = Schema.decodeUnknownSync(Schema.Struct({ input: ConnectionInput }))(await request.json())
        writes.push(body.input)
        const index = entries.findIndex((entry) => entry.role === body.input.role)
        entries[index] = {
          ...entries[index],
          url: body.input.url,
          custom: body.input.url !== undefined,
          authenticated: !!body.input.apiKey,
        }
        return json({ output: entries })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("permissions: Approve for me"))
  async function select(title: string, value: string) {
    await setup.waitForFrame(
      (frame) => frame.includes(title) && setup.renderer.currentFocusedEditor instanceof InputRenderable,
    )
    await setup.mockInput.typeText(value)
    await setup.waitForFrame((frame) => frame.includes(value))
    setup.mockInput.pressEnter()
  }
  async function open(title: string) {
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("Permissions")
    await setup.waitForFrame((frame) => frame.includes("Choose permissions"))
    setup.mockInput.pressEnter()
    await select("Permissions — this session", "Settings")
    await select("Permission settings", title)
  }
  async function edit(title: string) {
    await open(title)
    await select(`${title} — all sessions`, "Edit connection")
    await setup.waitForFrame(
      (frame) => frame.includes("base URL") && setup.renderer.currentFocusedEditor instanceof TextareaRenderable,
    )
  }
  await edit("Classifier connection")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("base URL"))
  expect(writes).toEqual([])
  await edit("Classifier connection")
  setup.mockInput.pressEnter()
  await select("authentication", "No API key")
  await setup.waitFor(() => writes.length === 1)
  expect(writes[0]).toEqual({ role: "classifier", url: "http://127.0.0.1:28443/v1", apiKey: "" })
  await edit("Chat fallback connection")
  await setup.mockInput.typeText("https://chat.invalid/v1")
  setup.mockInput.pressEnter()
  await select("authentication", "Set API key")
  await setup.waitForFrame(
    (frame) => frame.includes("— API key") && setup.renderer.currentFocusedEditor instanceof TextareaRenderable,
  )
  await setup.mockInput.typeText("fixture-api-key")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => writes.length === 2)
  expect(writes[1]).toEqual({ role: "fallback", url: "https://chat.invalid/v1", apiKey: "fixture-api-key" })
  await edit("Chat fallback connection")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Keep saved API key"))
  expect(setup.captureCharFrame()).not.toContain("fixture-api-key")
  await select("authentication", "Set API key")
  await setup.waitForFrame(
    (frame) => frame.includes("— API key") && setup.renderer.currentFocusedEditor instanceof TextareaRenderable,
  )
  expect((setup.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("— API key"))
  expect(writes).toHaveLength(2)
  await open("Chat fallback connection")
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Use configured provider") && setup.renderer.currentFocusedEditor instanceof InputRenderable,
  )
  setup.resize(44, 36)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Use configured provider")
  await select("connection", "Use configured provider")
  await setup.waitFor(() => writes.length === 3)
  expect(writes[2]).toEqual({ role: "fallback" })
})
