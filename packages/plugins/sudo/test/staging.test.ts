import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageHelper } from "../native"

test.skipIf(process.platform === "win32")(
  "staged helper survives package replacement and is removed after use",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sudo-staging-test-"))
    try {
      const binary = join(directory, "helper")
      const bytes = Buffer.from("verified original helper")
      await Bun.write(binary, bytes)
      await Bun.write(`${binary}.sha256`, createHash("sha256").update(bytes).digest("hex"))
      const staged = await stageHelper(binary)
      try {
        await Bun.write(binary, "replacement helper")
        expect(Buffer.from(await Bun.file(staged.path).arrayBuffer())).toEqual(bytes)
        expect((await stat(staged.path)).mode & 0o777).toBe(0o500)
        expect((await stat(join(staged.path, ".."))).mode & 0o777).toBe(0o700)
        await rm(binary)
        expect(Buffer.from(await Bun.file(staged.path).arrayBuffer())).toEqual(bytes)
      } finally {
        await staged[Symbol.asyncDispose]()
      }
      expect(await Bun.file(staged.path).exists()).toBe(false)
      await expect(stat(join(staged.path, ".."))).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === "win32")(
  "staging rejects bytes that no longer match the installed checksum",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sudo-staging-test-"))
    try {
      const binary = join(directory, "helper")
      await Bun.write(binary, "changed helper")
      await chmod(binary, 0o755)
      await Bun.write(`${binary}.sha256`, "0".repeat(64))
      await expect(stageHelper(binary)).rejects.toThrow("integrity check failed before staging")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
