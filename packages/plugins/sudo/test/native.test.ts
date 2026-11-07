import { expect, test } from "bun:test"

// These tests require real Unix job control, Python's pty module, and a C compiler. They never use real sudo.
test
  .skipIf(process.platform !== "linux")
  .each([
    "success",
    "nopasswd",
    "failure",
    "retry",
    "cancel",
    "handoff-cancel",
    "interrupt",
    "command-interrupt",
    "timeout",
    "flood",
    "suspend",
    "crash",
    "diagnostics",
    "slow-auth",
    "long-auth",
    "stale",
    "remote",
    "replace",
    "unlink",
    "resize",
    "escape-tail",
  ])("native password boundary: %s", async (scenario) => {
  const child = Bun.spawn(["python3", `${import.meta.dir}/fixture/native.py`, scenario], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, error }).toEqual({ code: 0, error: "" })
  expect(JSON.parse(output)).toEqual({ scenario, released: scenario !== "crash", credential_leaks: false })
})
