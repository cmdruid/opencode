import { mkdir, chmod } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

// Release-time compilation only. Plugin installation never runs a compiler or sudo.
if (!(process.platform === "linux" && process.arch === "x64") && !(process.platform === "darwin" && process.arch === "arm64"))
  throw new Error("Build native helpers on Linux x64 or macOS arm64.")
const directory = fileURLToPath(new URL(`../native/bin/${process.platform}-${process.arch}/`, import.meta.url))
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
    ...(process.platform === "linux" ? ["-static"] : ["-mmacosx-version-min=15.0"]),
    fileURLToPath(new URL("../native/helper.c", import.meta.url)),
    "-o",
    binary,
  ],
  { stdout: "inherit", stderr: "inherit" },
)
if (await child.exited) throw new Error("Native helper build failed")
await chmod(binary, 0o755)
if (process.platform === "darwin") {
  const signature = Bun.spawn(["/usr/bin/codesign", "--verify", "--strict", binary], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await signature.exited) throw new Error("Native helper signature verification failed")
}
await Bun.write(
  `${binary}.sha256`,
  createHash("sha256")
    .update(new Uint8Array(await Bun.file(binary).arrayBuffer()))
    .digest("hex") + "\n",
)
