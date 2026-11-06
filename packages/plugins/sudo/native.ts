import type { CliRenderer } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { chmod, lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import type { Request } from "./rpc"

export async function authenticate(
  renderer: CliRenderer,
  request: Request,
  theme: Plugin.Context["theme"],
  signal: AbortSignal,
) {
  if (process.platform === "win32" || !process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Native sudo requires a foreground Unix terminal on the server host.")
  const helper = await requireBundledHelper()
  signal.throwIfAborted()
  return takeTerminal(renderer, helper, [request.socket, request.id], theme, signal)
}

export async function requireBundledHelper(directory = new URL("./native/bin/", import.meta.url)) {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("This sudo plugin release supports Linux x64 terminals.")
  const helper = fileURLToPath(new URL("linux-x64/opencode-sudo-tty", directory))
  const info = await lstat(helper)
  if (!info.isFile() || (info.mode & 0o6002) !== 0 || (info.mode & 0o111) === 0)
    throw new Error("Invalid bundled sudo helper. Reinstall the plugin.")
  // npm/Bun may apply a group-writable umask when unpacking an otherwise 0755 asset.
  // Tighten our own executable before use; never repair another owner's file.
  if (info.mode & 0o020) {
    if (info.uid !== process.getuid?.())
      throw new Error("Bundled sudo helper is group-writable and owned by another user.")
    await chmod(helper, info.mode & ~0o020)
  }
  const expected = (await Bun.file(`${helper}.sha256`).text()).trim()
  const actual = createHash("sha256")
    .update(new Uint8Array(await Bun.file(helper).arrayBuffer()))
    .digest("hex")
  // Detect broken/mixed package assets. The installed plugin itself remains trusted code.
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected)
    throw new Error("Bundled sudo helper integrity check failed. Reinstall the plugin.")
  return helper
}

export function presentation(renderer: CliRenderer, theme?: Plugin.Context["theme"]) {
  const header = Buffer.alloc(36)
  header.write("OCUI1")
  header.writeUInt32BE(renderer.width, 8)
  header.writeUInt32BE(renderer.height, 12)
  const palette = theme?.surface("dialog")
  const colors = palette
    ? [
        palette.text.base,
        palette.background.base,
        palette.border.base,
        palette.text.muted,
        palette.text.action.primary.base,
      ]
    : []
  for (let index = 0; index < 5; index++) {
    const rgb = colors[index]?.toInts()
    header.writeUInt32BE(
      rgb && !process.env.NO_COLOR ? (rgb[0] << 16) | (rgb[1] << 8) | rgb[2] : 0xffffffff,
      16 + index * 4,
    )
  }
  // This is a pre-authentication snapshot of rendered cells, never a terminal readback.
  let text = ""
  try {
    text = renderer.currentRenderBuffer
      .getSpanLines()
      .slice(0, 200)
      .map((line) =>
        line.spans
          .map((span) => span.text)
          .join("")
          .replace(/[^\x20-\x7e]/g, " ")
          .slice(0, 500),
      )
      .join("\n")
  } catch {
    // Public buffer leases may be unavailable during presentation. Native branding is the fallback.
  }
  const bytes = Buffer.from(text.length <= 65536 ? text : "")
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return Buffer.concat([header, size, bytes])
}

/** Only exit 0 certifies that native code flushed input and restored the foreground terminal. */
export async function takeTerminal(
  renderer: CliRenderer,
  executable: string,
  args: string[],
  theme?: Plugin.Context["theme"],
  signal?: AbortSignal,
) {
  if (renderer.isDestroyed || renderer.controlState === "explicit_suspended")
    throw new Error("Terminal is already in use")
  const screen = presentation(renderer, theme)
  signal?.throwIfAborted()
  await renderer.suspend()
  if (signal?.aborted) {
    // No native process or password prompt exists yet, so this handoff can be unwound.
    await renderer.resume()
    return true
  }
  const released = await new Promise<boolean>((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", TERM: "dumb" },
    })
    // Cancellation requests native shutdown; only its normal guarded exit permits resume.
    const cancel = () => {
      child.kill("SIGTERM")
    }
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    child.once("close", () => signal?.removeEventListener("abort", cancel))
    const pipe = child.stdio[3]
    if (pipe && "end" in pipe) {
      pipe.on("error", () => undefined)
      pipe.end(screen)
    }
    child.once("error", () => resolve(false))
    child.once("exit", (code, signal) => resolve(code === 0 && signal === null))
  })
  if (!released) {
    // Resuming after a crash could put buffered password bytes into OpenCode's raw input diagnostics.
    process.stderr.write(
      "\nSudo terminal handoff failed. OpenCode remains suspended. Close this terminal and restart.\n",
    )
    return false
  }
  await renderer.resume()
  return true
}
