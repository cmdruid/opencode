import path from "node:path"
import { createAppFixture } from "../../../../tui/test/fixture/app"
import { directory, json } from "../../../../tui/test/fixture/tui-client"

export async function fixture(options: { shortcut?: string; pending?: boolean } = {}) {
  const session = {
    id: "ses_sudo_tui",
    title: "Sudo fixture",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const request = {
    id: "request",
    socket: "/tmp/unavailable-sudo-request",
    sessionID: session.id,
    command: "id -u",
    cwd: directory,
    host: "test-server",
    user: "owner",
  }
  const cancelled = Promise.withResolvers<unknown>()
  const state = { pending: options.pending ?? true }
  const app = await createAppFixture({
    width: 100,
    height: 30,
    config: {
      animations: false,
      keybinds: options.shortcut ? { "command.palette.show": options.shortcut } : undefined,
      plugins: [path.resolve(import.meta.dir, "../..")],
    },
    args: { sessionID: session.id },
    fetch: async (url, req) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/rpc/experimental.sudo/list") return json({ output: state.pending ? [request] : [] })
      if (url.pathname === "/api/rpc/experimental.sudo/cancel") {
        state.pending = false
        cancelled.resolve(await req.json())
        return json({ output: true })
      }
    },
  })
  return Object.assign(app, { cancelled, request })
}
