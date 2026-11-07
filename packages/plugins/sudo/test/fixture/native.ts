import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { takeTerminal } from "../../native"
import { createRequests } from "../../requests"

const [directory, executable, scenario] = process.argv.slice(2)
const command =
  scenario === "command-failure"
    ? "exit 7"
    : scenario === "command-interrupt"
      ? `touch ${directory}/command-started; sleep 30`
      : scenario === "timeout"
        ? "sleep 30"
        : scenario === "flood"
          ? "yes command-output"
          : "/usr/bin/python3 -c 'import os; assert not os.read(0, 1); assert not os.isatty(1); " +
            '\ntry: os.open("/dev/tty", os.O_RDONLY); raise AssertionError("command has a tty")' +
            '\nexcept OSError: pass\nprint("command-output")\''
const requests = createRequests()
const pending = await requests.ask(
  {
    id: crypto.randomUUID(),
    sessionID: "fixture",
    cwd: directory,
    command,
    reason: "Exercise the native handoff with fake sudo.",
    host: "test",
    user: "test",
  },
  ["timeout", "flood", "slow-auth"].includes(scenario) ? 100 : 5000,
  new AbortController().signal,
)
const result = pending.result.then((value) => Bun.write(`${directory}/result.json`, JSON.stringify(value ?? null)))
const handoff = new AbortController()
const cancel = setInterval(async () => {
  if (await Bun.file(`${directory}/cancel`).exists()) {
    if (scenario === "handoff-cancel") handoff.abort()
    else requests.cancel(pending.request.id)
  }
}, 20)
const setup = await createTestRenderer({
  stdin: process.stdin,
  stdout: process.stdout,
  width: process.stdout.columns || 80,
  height: process.stdout.rows || 24,
})
const conversation = new TextRenderable(setup.renderer, {
  id: "conversation",
  content: "OpenCode conversation\nUser: test sudo overlay\nAssistant: reviewing system status",
})
setup.renderer.root.add(conversation)
await setup.renderer.setupTerminal()
await setup.renderOnce()
const key = new Promise<void>((resolve) => setup.renderer.keyInput.once("keypress", () => resolve()))
process.stdout.write("FIXTURE_READY\n")
await key
conversation.content = "OpenCode conversation UPDATED immediately before handoff"
const released = await takeTerminal(
  setup.renderer,
  executable,
  [
    pending.request.socket + (scenario === "remote" ? ".missing" : ""),
    scenario === "stale" ? crypto.randomUUID() : pending.request.id,
  ],
  undefined,
  handoff.signal,
)
clearInterval(cancel)
requests.close()
await result
await Bun.write(`${directory}/release.json`, JSON.stringify({ released }))
if (released) {
  const fresh = new Promise<string>((resolve) => setup.renderer.keyInput.once("keypress", (key) => resolve(key.name)))
  process.stdout.write("APP_RESUMED\n")
  await Bun.write(`${directory}/fresh-key`, await fresh)
  await setup[Symbol.asyncDispose]()
}
// An abnormal helper exit must not resume/destroy the suspended renderer in the fixture either.
process.exit(0)
