import { mkdir, chmod } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

// Release-time compilation only. Plugin installation never runs a compiler or sudo.
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("The initial sudo plugin release supports Linux x64. Build releases on that platform.")
const directory = fileURLToPath(new URL("../native/bin/linux-x64/", import.meta.url))
await mkdir(directory, { recursive: true })
const binary = `${directory}/opencode-sudo-tty`
const child = Bun.spawn(
  [
    "/usr/bin/cc",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    "-static",
    fileURLToPath(new URL("../native/helper.c", import.meta.url)),
    "-o",
    binary,
  ],
  { stdout: "inherit", stderr: "inherit" },
)
if (await child.exited) throw new Error("Native helper build failed")
await chmod(binary, 0o755)
await Bun.write(
  `${binary}.sha256`,
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
    .digest("hex") + "\n",
)
