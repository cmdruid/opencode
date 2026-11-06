import { expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { requireBundledHelper } from "../native"

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "packed plugin includes a working native helper without installation hooks or workspace runtime dependencies",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sudo-package-"))
    try {
      const build = Bun.spawn(["bun", "run", "build:native"], {
        cwd: join(import.meta.dir, ".."),
        stdout: "ignore",
        stderr: "pipe",
      })
      expect({ code: await build.exited, error: await new Response(build.stderr).text() }).toMatchObject({ code: 0 })
      const pack = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--destination", directory], {
        cwd: join(import.meta.dir, ".."),
        stdout: "ignore",
        stderr: "pipe",
      })
      expect({ code: await pack.exited, error: await new Response(pack.stderr).text() }).toMatchObject({ code: 0 })
      const extract = Bun.spawn(["tar", "-xzf", join(directory, "opencode-plugin-sudo-0.0.0.tgz"), "-C", directory])
      expect(await extract.exited).toBe(0)
      const root = join(directory, "package")
      const metadata = await Bun.file(join(root, "package.json")).json()
      for (const hook of ["install", "preinstall", "postinstall", "prepare"])
        expect(metadata.scripts[hook]).toBeUndefined()
      expect(JSON.stringify(metadata.peerDependencies)).not.toMatch(/workspace:|catalog:/)
      expect(metadata.private).not.toBe(true)
      const entries = Host.resolve({ directory: root })
      expect(entries.server).toContain("index.ts")
      expect(entries.tui).toContain("tui.tsx")
      expect(await Bun.file(join(root, "native/screen.h")).exists()).toBe(true)
      const helper = await requireBundledHelper(pathToFileURL(`${root}/native/bin/`))
      const run = Bun.spawn([helper], { stdout: "pipe", stderr: "pipe" })
      expect(await run.exited).toBe(125)
      expect(await new Response(run.stderr).text()).toContain("Usage:")
      // A damaged or mixed-version bundle must fail before taking the user's terminal.
      await writeFile(`${helper}.sha256`, "0".repeat(64))
      await expect(requireBundledHelper(pathToFileURL(`${root}/native/bin/`))).rejects.toThrow("integrity check failed")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
