import assert from "node:assert/strict"
import { createTestRenderer } from "@opentui/core/testing"
import { fixture } from "./app"
import { createRequests } from "../../requests"
import { directory } from "../../../../tui/test/fixture/tui-client"
import { waitForHighlightedFrame } from "../../../../tui/test/fixture/frame"

const root = process.argv[2]
const requests = createRequests()
const info = {
  sessionID: "ses_sudo_tui",
  cwd: root,
  host: "test-server",
  user: "owner",
  reason: "Exercise the native handoff with fake sudo.",
}
const first = await requests.ask(
  { ...info, id: crypto.randomUUID(), command: "printf 'command-output\\n'" },
  5000,
  new AbortController().signal,
)
const second = await requests.ask(
  { ...info, id: crypto.randomUUID(), command: "printf second-command" },
  5000,
  new AbortController().signal,
)
const setup = await createTestRenderer({
  stdin: process.stdin,
  stdout: process.stdout,
  width: Number(process.env.TEST_UI_WIDTH),
  height: process.env.TEST_UI_WIDTH === "40" ? 16 : 30,
  kittyKeyboard: true,
})
await setup.renderer.setupTerminal()
await using app = await fixture({ setup, plugin: `${root}/plugin`, requests })
await app.ready
await waitForHighlightedFrame(app, (frame) => frame.includes("Enter approve"))
const result = first.result.then(async (value) => {
  await Bun.write(`${root}/result.json`, JSON.stringify(value ?? null))
  app.events.emit({
    id: "closed-before-restoration",
    created: 0,
    type: "rpc.experimental.sudo.closed",
    location: { directory },
    data: { id: first.request.id },
  })
  assert.equal(app.renderer.controlState, "explicit_suspended")
  // A ReadStream buffer is outside the kernel's tcflush. It must be discarded
  // before resume can feed it through diagnostics and the composer's key parser.
  app.renderer.stdin.push(Buffer.from("DUMMY_NATIVE_AUTH_BUFFER"))
  await Bun.write(`${root}/closed-observed`, "1")
})
const next = new Promise<void>((resolve) => {
  const frame = () => {
    if (!app.captureCharFrame().includes("second-command")) return
    app.renderer.off("frame", frame)
    resolve()
  }
  app.renderer.on("frame", frame)
})
process.stdout.write("FIXTURE_READY\n")
await result
await next
assert.notEqual(app.renderer.controlState, "explicit_suspended")
assert(!app.captureCharFrame().includes("Request closed"))
assert(!app.captureCharFrame().includes("DUMMY_NATIVE_AUTH"))
assert.equal(requests.list(info.sessionID).length, 1)
app.mockInput.pressEscape()
await app.waitForFrame((frame) => !frame.includes("Enter approve"))
const fresh = new Promise<string>((resolve) => app.renderer.keyInput.once("keypress", (key) => resolve(key.name)))
await Bun.write(`${root}/release.json`, JSON.stringify({ released: true }))
process.stdout.write("APP_RESUMED\n")
await Bun.write(`${root}/fresh-key`, await fresh)
assert.equal(await second.result, undefined)
requests.close()

app.renderer.destroy()
app.events.disconnect()
