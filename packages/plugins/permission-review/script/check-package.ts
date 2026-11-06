import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ServerSettings } from "../contract"

const tarball = path.resolve(process.argv[2] ?? "")
const binary = path.resolve(process.argv[3] ?? "")
if (process.argv.length < 4)
  throw new Error("Usage: bun run check:package <tarball> <compatible-opencode-binary>; requires tmux")
const root = await mkdtemp(path.join(tmpdir(), "permission-package-check-"))
const project = path.join(root, "project")
await mkdir(project)
await mkdir(path.join(root, "config"))
const run = async (args: string[], env = process.env) => {
  const child = Bun.spawn(args, { cwd: root, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(`${args[0]} exited ${code}: ${stderr}`)
  return stdout
}
const files = (await run(["tar", "-tzf", tarball])).trim().split("\n").sort()
assert.deepEqual(
  files,
  [
    "LICENSE",
    "README.md",
    "connections.ts",
    "contract.ts",
    "index.ts",
    "package.json",
    "review.ts",
    "settings.ts",
    "tui.js",
  ]
    .map((file) => `package/${file}`)
    .sort(),
)
await Bun.write(
  path.join(root, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@cmdcode/opencode-auto-permissions": `file:${tarball}` } }),
)
await run(["bun", "install", "--ignore-scripts"])
const installed = path.join(root, "node_modules/@cmdcode/opencode-auto-permissions")
assert.equal(await realpath(installed), installed)
const manifest = await Bun.file(path.join(installed, "package.json")).json()
assert.equal(manifest.name, "@cmdcode/opencode-auto-permissions")
assert.equal(manifest.version, "0.1.0-alpha.0")
assert.equal(manifest.private, true)
assert.equal(manifest.devDependencies, undefined)
assert.equal(manifest.scripts, undefined)
assert.deepEqual(manifest.exports, { ".": "./index.ts", "./server": "./index.ts", "./tui": "./tui.js" })
for (const file of Object.values(manifest.exports)) assert(await Bun.file(path.join(installed, String(file))).exists())
const calls: string[] = []
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    calls.push(new URL(request.url).pathname)
    await request.json()
    return Response.json({
      model: "decision",
      answers: {
        permission: {
          type: "choice",
          choice: "approve",
          probabilities: { approve: 1, deny: 0, escalate: 0 },
          confidence: 1,
        },
      },
    })
  },
})
const env = {
  ...process.env,
  OPENCODE_TEST_HOME: root,
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_PASSWORD: crypto.randomUUID(),
  OPENCODE_CONFIG: "",
  OPENCODE_CONFIG_CONTENT: "",
}
await Bun.write(
  path.join(root, "config/opencode.json"),
  JSON.stringify(
    {
      update: "disable",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
      providers: {
        fixture: {
          package: "@opencode/ai/providers/typesafe-ai/decisions",
          settings: { baseURL: `${model.url}v1`, apiKey: false },
          models: { decision: { type: "decision" } },
        },
      },
      plugins: [
        {
          package: installed,
          options: { model: { providerID: "fixture", id: "decision" }, mode: "decision", defaultMode: "auto" },
        },
      ],
    },
    null,
    2,
  ),
)
await Bun.write(path.join(project, "README.md"), "Inert package verification fixture.\n")
const start = async () => {
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: Bun.file(path.join(root, "server.log")),
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = AbortSignal.timeout(30000)
  const stop = () => child.kill()
  deadline.addEventListener("abort", stop, { once: true })
  let output = ""
  while (!deadline.aborted) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Server exited before readiness: ${output}; see ${root}/server.log`)
    output += decoder.decode(chunk.value)
    const url = output.match(/server listening on (http:\/\/\S+)/)?.[1]
    if (url) {
      deadline.removeEventListener("abort", stop)
      reader.releaseLock()
      return { child, url }
    }
  }
  child.kill()
  throw new Error("Server startup timed out")
}
const socket = `permission-package-${crypto.randomUUID()}`
let server: Awaited<ReturnType<typeof start>> | undefined
const request = async <T>(route: string, body?: unknown): Promise<T> => {
  const url = new URL(route, server!.url)
  url.searchParams.set("location[directory]", project)
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json()
}
const rpc = async <T>(name: string, input: unknown = {}) =>
  (await request<{ output: T }>(`/api/rpc/opencode.permission-review/${name}`, { input })).output
try {
  server = await start()
  const initial = await rpc<ServerSettings>("settings")
  assert.equal(initial.values.minConfidence, 0.98)
  await rpc("saveSettings", { patch: { minConfidence: 0.91 } })
  server.child.kill("SIGTERM")
  await server.child.exited
  server = await start()
  assert.equal((await rpc<ServerSettings>("settings")).values.minConfidence, 0.91)
  const inventory = await request<{ data: { id?: string; features: { tui?: boolean }; state: { status: string } }[] }>(
    "/api/plugin",
  )
  const plugin = inventory.data.find((item) => item.id === "opencode.permission-review")
  assert.equal(plugin?.state.status, "active")
  assert.equal(plugin?.features.tui, true)
  const session = await request<{ data: { id: string } }>("/api/session", { location: { directory: project } })
  // Seed explicit authorization through the real native-action RPC; neither request executes a tool.
  const first = await request<{ data: { id: string; effect: string } }>(`/api/session/${session.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(first.data.effect, "ask")
  assert.deepEqual(calls, [])
  await rpc("allowSession", { sessionID: session.data.id, requestID: first.data.id })
  const permission = await request<{ data: { effect: string } }>(`/api/session/${session.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(permission.data.effect, "allow")
  assert.deepEqual(calls, ["/v1/systemone"])
  await run(
    [
      "tmux",
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      "check",
      "-x",
      "112",
      "-y",
      "36",
      binary,
      "--server",
      server.url,
      project,
    ],
    env,
  )
  const frame = () => run(["tmux", "-L", socket, "capture-pane", "-p", "-t", "check"], env)
  const waitFrame = async (text: string) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const screen = await frame()
      if (screen.includes(text)) return screen
      await Bun.sleep(100)
    }
    throw new Error(`TUI did not show ${text}:\n${await frame()}`)
  }
  await waitFrame("commands")
  await run(["tmux", "-L", socket, "send-keys", "-t", "check", "C-p"], env)
  await waitFrame("command")
  await run(["tmux", "-L", socket, "send-keys", "-t", "check", "-l", "Permissions"], env)
  await waitFrame("Choose permissions")
  await run(["tmux", "-L", socket, "send-keys", "-t", "check", "Enter"], env)
  await Bun.write(path.join(root, "tui.txt"), await waitFrame("Type to filter"))
  const report = {
    tarball,
    sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(tarball).arrayBuffer()).digest("hex"),
    files,
    host: binary,
    hostVersion: (await run([binary, "--version"], env)).trim(),
    hostSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex"),
    installed,
    settingsPersisted: true,
    companionLoaded: true,
    permission: permission.data,
    modelCalls: calls,
    limitation: "Requires this fork's experimental APIs; public plugin SDK alone is insufficient.",
  }
  await Bun.write(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(`Verified package: ${root}/verification.json`)
} finally {
  await run(["tmux", "-L", socket, "kill-server"], env).catch(() => undefined)
  server?.child.kill("SIGTERM")
  await server?.child.exited
  await model.stop(true)
}
