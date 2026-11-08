import { expect, test } from "bun:test"
import { directory } from "../../../tui/test/fixture/tui-client"
import { fixture } from "./fixture/app"

test("installed TUI plugin requests terminal handoff, never a password response", async () => {
  await using app = await fixture({ shortcut: "p" })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("sudo ·"))
    await app.mockInput.typeText("plain-input")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("sudo ·")
    expect(app.captureCharFrame()).not.toContain("plain-input")
    // The fixture has no real terminal; the production preflight must reject before suspending it.
    app.mockInput.pressEnter()
    expect(await app.cancelled.promise).toEqual({ input: { id: "request" } })
    await app.waitForFrame((frame) => frame.includes("Cannot open native sudo"))
    expect(app.captureCharFrame()).toContain("Request closed")
  } finally {
    app.renderer.destroy()
    app.events.disconnect()
  }
})

test.each(["cancel", "closed"])("queued approvals survive %s of the active prompt", async (action) => {
  await using app = await fixture()
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("sudo ·"))
    app.events.emit({
      id: "evt_sudo_second",
      created: 0,
      type: "rpc.experimental.sudo.requested",
      location: { directory },
      data: { ...app.request, id: "second", command: "printf second-command" },
    })
    if (action === "closed") {
      app.events.emit({
        id: "evt_sudo_closed",
        created: 0,
        type: "rpc.experimental.sudo.closed",
        location: { directory },
        data: { id: app.request.id },
      })
      await app.waitForFrame((frame) => frame.includes("Request closed"))
      app.mockInput.pressEnter()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Request closed")
    }
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("second-command"))
    expect(app.captureCharFrame()).not.toContain("Request closed")
  } finally {
    app.renderer.destroy()
    app.events.disconnect()
  }
})

test("pending sudo waits for another dialog to close", async () => {
  await using app = await fixture({ shortcut: "p", pending: false })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("p")
    await app.waitForFrame((frame) => frame.includes("Switch model"))
    app.events.emit({
      id: "evt_sudo_deferred",
      created: 0,
      type: "rpc.experimental.sudo.requested",
      location: { directory },
      data: app.request,
    })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("sudo ·")
    expect(app.captureCharFrame()).toContain("Switch model")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("sudo ·"))
  } finally {
    app.renderer.destroy()
    app.events.disconnect()
  }
})

test("pending sudo waits for a suspended terminal to resume", async () => {
  await using app = await fixture({ pending: false })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.renderer.suspend()
    app.events.emit({
      id: "evt_sudo_suspended",
      created: 0,
      type: "rpc.experimental.sudo.requested",
      location: { directory },
      data: app.request,
    })
    expect(app.renderer.controlState === "explicit_suspended").toBe(true)
    await app.renderer.resume()
    await app.waitForFrame((frame) => frame.includes("sudo ·"))
  } finally {
    app.renderer.destroy()
    app.events.disconnect()
  }
})

test.skipIf(!["linux", "darwin"].includes(process.platform)).each([40, 100])(
  "loaded plugin waits for native cleanup before advancing the queue at %s columns",
  async (width) => {
    const child = Bun.spawn(["python3", `${import.meta.dir}/fixture/native.py`, "loaded", String(width)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, error }).toEqual({ code: 0, error: "" })
    expect(JSON.parse(output)).toEqual({ scenario: "loaded", released: true, credential_leaks: false })
  },
)
