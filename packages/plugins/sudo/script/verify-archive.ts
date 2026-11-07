import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const archive = process.argv[2]
if (!archive) throw new Error("Usage: bun run verify:archive ARCHIVE.tgz")
const directory = await mkdtemp(join(tmpdir(), "sudo-release-test-"))
try {
  const extract = Bun.spawn(["tar", "-xzf", resolve(archive), "-C", directory], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await extract.exited) throw new Error("Could not extract the release archive")
  const tests = Bun.spawn(["bun", "test", "--timeout", "30000"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODE_SUDO_TARBALL: resolve(archive),
      SUDO_NATIVE_SOURCE: join(directory, "package/native"),
      SUDO_PACKAGE_ROOT: join(directory, "package"),
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (await tests.exited) throw new Error("Release archive verification failed")
} finally {
  await rm(directory, { recursive: true, force: true })
}
