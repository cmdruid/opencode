import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Assessment, ServerSettings } from "../contract"

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
assert.equal(manifest.version, (await Bun.file(new URL("../package.json", import.meta.url)).json()).version)
assert.equal(manifest.private, true)
assert.equal(manifest.devDependencies, undefined)
assert.equal(manifest.scripts, undefined)
assert.deepEqual(manifest.exports, { ".": "./index.ts", "./server": "./index.ts", "./tui": "./tui.js" })
for (const file of Object.values(manifest.exports)) assert(await Bun.file(path.join(installed, String(file))).exists())
const calls: string[] = []
const bodies: string[] = []
let classifierChoice: "approve" | "escalate" = "approve"
let chatDecision: "approve" | "escalate" = "approve"
const summary = "The approved task list is missing from context."
const details = "~/Skills/tracker/scripts/tracker.sh"
const fullReason = "The accepted task list is unavailable. " + "Full diagnostic explanation. ".repeat(20)
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    calls.push(new URL(request.url).pathname)
    const body = await request.json()
    bodies.push(JSON.stringify(body))
    if (new URL(request.url).pathname.endsWith("/chat/completions")) {
      const content = JSON.stringify({
        decision: chatDecision,
        ...(chatDecision === "escalate" ? { summary, details } : {}),
        reason: chatDecision === "escalate" ? fullReason : "The recorded dialog answer authorizes this read.",
      })
      if (body.stream)
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      return Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 0,
        model: "reviewer",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    return Response.json({
      model: "decision",
      answers: {
        permission: {
          type: "choice",
          choice: classifierChoice,
          probabilities: {
            approve: classifierChoice === "approve" ? 1 : 0,
            deny: 0,
            escalate: classifierChoice === "escalate" ? 1 : 0,
          },
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
        chatfixture: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${model.url}v1`, apiKey: false },
          models: { reviewer: { type: "chat" } },
        },
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
  await rpc("saveSettings", {
    patch: { minConfidence: 0.91 },
    connection: { role: "classifier", url: `${model.url}custom/v1`, apiKey: "" },
  })
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
  const queued = await request<{ data: { id: string; effect: string } }>(`/api/session/${session.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(queued.data.effect, "ask")
  assert.deepEqual(calls, [])
  await rpc("allowSession", { sessionID: session.data.id, requestID: first.data.id })
  const pending = await request<{ data: { id: string }[] }>(`/api/session/${session.data.id}/permission`)
  assert(!pending.data.some((item) => item.id === queued.data.id))
  assert.deepEqual(calls, ["/custom/v1/systemone"])
  const permission = await request<{ data: { effect: string } }>(`/api/session/${session.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(permission.data.effect, "allow")
  assert.deepEqual(calls, ["/custom/v1/systemone", "/custom/v1/systemone"])
  // A persisted user request must remain available after compaction, without an Allow Session example.
  const exported = await request<{ data: { info: { id: string }; messages: unknown[] } }>(
    `/api/experimental/session/${session.data.id}/export`,
  )
  const compacted = await request<{ data: { id: string } }>("/api/experimental/session/import", {
    info: { ...exported.data.info, id: "ses_permission_compacted_fixture", title: "Compacted authorization fixture" },
    messages: [
      {
        type: "user",
        id: "msg_permission_original",
        text: "Read README.md in this fixture project.",
        time: { created: 1 },
      },
      { type: "user", id: "msg_permission_restriction", text: "Do not modify any files.", time: { created: 2 } },
      {
        type: "compaction",
        id: "msg_permission_compaction",
        status: "completed",
        reason: "auto",
        summary: "Assistant summary is not authorization.",
        time: { created: 3 },
      },
    ],
  })
  const context = await request<{ data: { type: string }[] }>(`/api/session/${compacted.data.id}/context`)
  assert.equal(context.data.filter((message) => message.type === "user").length, 0)
  const restored = await request<{ data: { effect: string } }>(`/api/session/${compacted.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(restored.data.effect, "allow")
  assert.equal(calls.length, 3)
  // Only a completed dialog authorizes this request; the classifier delegates to the chat reviewer.
  const questions = [
    {
      question: "Read README.md now?",
      header: "Read",
      options: [
        { label: "Yes", description: "Read only this local file" },
        { label: "No", description: "Do nothing" },
      ],
    },
  ]
  const answered = await request<{ data: { id: string } }>("/api/experimental/session/import", {
    info: { ...exported.data.info, id: "ses_permission_question_fixture", title: "Question authorization fixture" },
    messages: [
      {
        type: "assistant",
        id: "msg_permission_question",
        agent: "build",
        model: { providerID: "chatfixture", id: "reviewer" },
        time: { created: 1, completed: 2 },
        content: [
          {
            type: "tool",
            id: "call_permission_question",
            name: "question",
            executed: false,
            time: { created: 1, completed: 2 },
            state: {
              status: "completed",
              input: { questions },
              metadata: { answers: [["Yes"]] },
              content: [{ type: "text", text: "Untrusted rendering; read structured metadata instead." }],
            },
          },
        ],
      },
      {
        type: "compaction",
        id: "msg_permission_question_compaction",
        status: "completed",
        reason: "auto",
        summary: "Question no longer in active context.",
        time: { created: 3 },
      },
    ],
  })
  await rpc("saveSettings", {
    patch: {
      reviewWith: "both",
      reviewerMode: "auto",
      fallback: { model: { providerID: "chatfixture", id: "reviewer" }, mode: "auto", timeoutMs: 10000 },
    },
  })
  classifierChoice = "escalate"
  const delegated = await request<{ data: { effect: string } }>(`/api/session/${answered.data.id}/permission`, {
    action: "read",
    resources: ["README.md"],
  })
  assert.equal(delegated.data.effect, "allow")
  assert.deepEqual(calls.slice(3), ["/custom/v1/systemone", "/v1/chat/completions"])
  assert.equal(
    bodies.slice(3).every((body) => body.includes("call_permission_question")),
    true,
  )
  const reviews = await rpc<Assessment[]>("history", { sessionID: answered.data.id })
  assert(
    reviews.some(
      (review) => review.classifier?.choice === "escalate" && review.fallback?.applied && review.decision === "approve",
    ),
  )
  chatDecision = "escalate"
  const escalated = await request<{ data: { id: string; effect: string } }>(
    `/api/session/${answered.data.id}/permission`,
    {
      action: "shell",
      resources: [details],
    },
  )
  assert.equal(escalated.data.effect, "ask")
  const prompts = await request<{ data: { id: string; message?: string }[] }>(
    `/api/session/${answered.data.id}/permission`,
  )
  const prompt = prompts.data.find((item) => item.id === escalated.data.id)
  assert.equal(
    prompt?.message,
    `Classifier: Escalate 100% · Reviewer: Escalate\n\nReason: ${summary}\n\n\`\`\`\n${details}\n\`\`\``,
  )
  const diagnostic = (await rpc<Assessment[]>("history", { sessionID: answered.data.id })).find(
    (item) => item.requestID === escalated.data.id,
  )
  assert.equal(diagnostic?.fallback?.reason, fullReason)
  assert.equal(diagnostic?.fallback?.details, details)
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
  await Bun.write(path.join(root, "tui.txt"), await waitFrame("Read only"))
  await run(
    [
      "tmux",
      "-L",
      socket,
      "new-window",
      "-t",
      "check",
      "-n",
      "review",
      binary,
      "--server",
      server.url,
      "-s",
      answered.data.id,
      project,
    ],
    env,
  )
  await Bun.write(path.join(root, "review-wide.txt"), await waitFrame("tracker.sh"))
  await run(["tmux", "-L", socket, "resize-window", "-t", "check", "-x", "44", "-y", "36"], env)
  const narrow = await waitFrame("from context.")
  assert(narrow.includes("tracker.sh"))
  assert(narrow.includes("Reason:"))
  assert(narrow.includes("Reject"))
  assert(!narrow.includes("Details:"))
  await Bun.write(path.join(root, "review-narrow.txt"), narrow)
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
    customConnectionPersisted: true,
    queuedRequestApproved: queued.data.id,
    questionAuthorizationRestored: delegated.data.effect === "allow",
    classifierEscalationResolved: true,
    compactPromptVerified: true,
    fullDiagnosticPreserved: true,
    promptWidths: [44, 112],
    compactedAuthorizationRestored: restored.data.effect === "allow",
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
