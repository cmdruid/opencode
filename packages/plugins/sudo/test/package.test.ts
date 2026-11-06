import { expect, test } from "bun:test"
import { Host } from "@opencode/plugin/host"
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { requireBundledHelper } from "../native"
import manifest from "../package.json"

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "packed plugin includes a working native helper without installation hooks or workspace runtime dependencies",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sudo-package-"))
    try {
      const archive =
        process.env.OPENCODE_SUDO_TARBALL ?? join(directory, `cmdcode-opencode-safe-sudo-${manifest.version}.tgz`)
      if (!process.env.OPENCODE_SUDO_TARBALL) {
        const build = Bun.spawn(["bun", "run", "build"], {
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
      }
      const extract = Bun.spawn(["tar", "-xzf", archive, "-C", directory])
      expect(await extract.exited).toBe(0)
      const root = join(directory, "package")
      const metadata = await Bun.file(join(root, "package.json")).json()
      expect(metadata.name).toBe("@cmdcode/opencode-safe-sudo")
      expect(metadata.version).toBe(manifest.version)
      expect(metadata.publishConfig).toEqual({ access: "public", registry: "https://registry.npmjs.org/" })
      expect(metadata.license).toBe("MIT")
      expect(await Bun.file(join(root, "LICENSE")).text()).toContain("MIT License")
      for (const hook of ["install", "preinstall", "postinstall", "prepare"])
        expect(metadata.scripts[hook]).toBeUndefined()
      expect(JSON.stringify(metadata.peerDependencies)).not.toMatch(/workspace:|catalog:/)
      expect(metadata.private).not.toBe(true)
      await symlink(join(import.meta.dir, "../node_modules"), join(root, "node_modules"), "dir")
      const entries = Host.resolve({ directory: root })
      expect(entries.server).toContain("index.ts")
      expect(entries.tui).toContain("tui.js")
      expect(await Bun.file(join(root, "native/screen.h")).exists()).toBe(true)
      // A fresh consumer process avoids the test runner's host-module interception/cache.
      const tui = Bun.spawn(
        [
          "bun",
          "-e",
          'const plugin = await import("./tui.js"); if (!plugin.default) throw new Error("Missing TUI entry")',
        ],
        {
          cwd: root,
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      expect({ code: await tui.exited, error: await new Response(tui.stderr).text() }).toEqual({ code: 0, error: "" })
      const helper = await requireBundledHelper(pathToFileURL(`${root}/native/bin/`))
      await chmod(helper, 0o775)
      await requireBundledHelper(pathToFileURL(`${root}/native/bin/`))
      expect((await lstat(helper)).mode & 0o022).toBe(0)
      await chmod(helper, 0o777)
      await expect(requireBundledHelper(pathToFileURL(`${root}/native/bin/`))).rejects.toThrow(
        "Invalid bundled sudo helper",
      )
      await chmod(helper, 0o4755)
      await expect(requireBundledHelper(pathToFileURL(`${root}/native/bin/`))).rejects.toThrow(
        "Invalid bundled sudo helper",
      )
      await chmod(helper, 0o755)
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
