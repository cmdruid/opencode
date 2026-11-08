import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join } from "node:path"

/** Packaging consumes both native builds; it must never silently ship only the host platform. */
export async function verifyHelpers(directory: string) {
  for (const platform of ["linux-x64", "darwin-arm64"]) {
    const binary = join(directory, platform, "opencode-sudo-tty")
    const info = await lstat(binary)
    if (!info.isFile() || (info.mode & 0o6022) !== 0 || (info.mode & 0o111) === 0)
      throw new Error(`Invalid release helper permissions: ${platform}`)
    const bytes = Buffer.from(await Bun.file(binary).arrayBuffer())
    const expected = (await Bun.file(`${binary}.sha256`).text()).trim()
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Release helper integrity check failed: ${platform}`)
    const valid =
      platform === "linux-x64"
        ? bytes.length >= 64 &&
          bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
          bytes.readUInt16LE(18) === 62
        : bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c
    if (!valid) throw new Error(`Wrong release helper architecture: ${platform}`)
  }
}

if (import.meta.main) await verifyHelpers(join(import.meta.dir, "../native/bin"))
