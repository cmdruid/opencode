import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const destination = path.resolve(process.argv[2] ?? path.join(root, "artifacts"))
await mkdir(destination, { recursive: true })
const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (await build.exited) throw new Error("TUI build failed")
const manifest = await Bun.file(path.join(root, "package.json")).json()
const stage = await mkdtemp(path.join(tmpdir(), "permission-pack-"))
try {
  await Promise.all(manifest.files.map((file: string) => cp(path.join(root, file), path.join(stage, file))))
  // Development scripts refer to excluded files; no workspace/catalog metadata belongs in the artifact.
  delete manifest.devDependencies
  delete manifest.scripts
  await Bun.write(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
  const pack = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--destination", destination], {
    cwd: stage,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await pack.exited) throw new Error("Package creation failed")
} finally {
  await rm(stage, { recursive: true, force: true })
}
