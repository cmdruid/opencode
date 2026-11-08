// Run in a human-owned terminal. No recorder, fake sudo, or agent input transport.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run this in your own terminal")
if (
  Object.keys(process.env).some(
    (key) => /^(OTUI_STDIN_LOG|OTUI_DEBUG|OTUI_NATIVE_INPUT_SHADOW)$/.test(key) && process.env[key],
  )
)
  throw new Error("Disable OpenTUI input diagnostics before real authentication")

const { createTestRenderer } = await import("@opentui/core/testing")
const { fixture } = await import("../test/fixture/app")
const { createRequests } = await import("../requests")
const { directory } = await import("../../../tui/test/fixture/tui-client")
const root = await mkdtemp(join(tmpdir(), "sudo-human-check-"))
const requests = createRequests()
try {
  const pending = await requests.ask(
    {
      id: crypto.randomUUID(),
      sessionID: "ses_sudo_tui",
      cwd: root,
      command: "/usr/bin/id -u",
      reason: "Verify native sudo authentication with a read-only identity command.",
      host: "local host — isolated check",
      user: process.env.USER ?? "local user",
    },
    5000,
    new AbortController().signal,
  )
  const setup = await createTestRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
    kittyKeyboard: true,
    bufferedOutput: "stdout",
    screenMode: "alternate-screen",
  })
  await setup.renderer.setupTerminal()
  await using app = await fixture({ setup, requests, plugin: process.argv[2] })
  await app.ready
  const result = await pending.result
  app.events.emit({
    id: "human-check-closed",
    created: 0,
    type: "rpc.experimental.sudo.closed",
    location: { directory },
    data: { id: pending.request.id },
  })
  // The broker can finish before native cleanup. Reading a frame while suspended
  // throws InvalidPhase; wait for a resumed frame without acquiring a buffer lease.
  await new Promise<void>((resolve, reject) => {
    const frame = () => {
      if (app.renderer.controlState === "explicit_suspended") return
      app.renderer.off("frame", frame)
      app.renderer.off("destroy", destroyed)
      resolve()
    }
    const destroyed = () => {
      app.renderer.off("frame", frame)
      reject(new Error("Renderer closed before the terminal returned"))
    }
    app.renderer.on("frame", frame)
    app.renderer.once("destroy", destroyed)
  })
  app.renderer.destroy()
  await app.renderer.closed
  app.events.disconnect()
  console.log(JSON.stringify({ command: "/usr/bin/id -u", result: result ?? "cancelled" }))
} finally {
  requests.close()
  await rm(root, { recursive: true, force: true })
}
