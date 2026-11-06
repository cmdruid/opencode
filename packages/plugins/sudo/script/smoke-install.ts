import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const archive = process.argv[2]
if (!archive) throw new Error("Usage: bun script/smoke-install.ts ARCHIVE.tgz")
const directory = await mkdtemp(join(tmpdir(), "safe-sudo-install-"))
try {
  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({ name: "safe-sudo-smoke", private: true, type: "module" }),
  )
  const install = Bun.spawn(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      resolve(archive),
    ],
    {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  if (await install.exited) throw new Error("Clean npm installation failed")
  await Bun.write(
    join(directory, "check.ts"),
    `
    import { dirname, join } from "node:path"
    const server = await import("@cmdcode/opencode-safe-sudo/server")
    const tui = await import("@cmdcode/opencode-safe-sudo/tui")
    if (!server.default || !tui.default) throw new Error("Missing plugin entry")
    const root = dirname(Bun.resolveSync("@cmdcode/opencode-safe-sudo/server", import.meta.dir))
    const { requireBundledHelper } = await import(join(root, "native.ts"))
    const child = Bun.spawn([await requireBundledHelper()], { stdout: "ignore", stderr: "ignore" })
    if (await child.exited !== 125) throw new Error("Helper did not reject empty arguments")
    console.log("PASS clean npm install, server/TUI imports, helper integrity and permissions")
  `,
  )
  const check = Bun.spawn(["bun", "check.ts"], { cwd: directory, stdout: "inherit", stderr: "inherit" })
  if (await check.exited) throw new Error("Installed plugin smoke test failed")
} finally {
  await rm(directory, { recursive: true, force: true })
}
