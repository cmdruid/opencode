import { expect, test } from "bun:test"

// These tests require real Unix job control, Python's pty module, and a C compiler. They never use real sudo.
test
  .skipIf(!["linux", "darwin"].includes(process.platform))
  .each([
    "success",
    "nopasswd",
    "failure",
    "command-failure",
    "retry",
    "cancel",
    "handoff-cancel",
    "interrupt",
    "command-interrupt",
    "timeout",
    "flood",
    "suspend",
    "crash",
    "attributes",
    "readback",
    "ownership",
    "foreground-readback",
    "diagnostics",
    "slow-auth",
    "long-auth",
    "stale",
    "remote",
    "replace",
    "unlink",
    "overwrite",
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
  expect(JSON.parse(output)).toEqual({
    scenario,
    released: !["crash", "attributes", "readback", "ownership", "foreground-readback"].includes(scenario),
    credential_leaks: false,
  })
})
