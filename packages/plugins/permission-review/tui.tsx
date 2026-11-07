import { open } from "node:fs/promises"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Contract, type State } from "./contract.js"
import { PermissionSettings, reviewLabels, scopeName } from "./settings-ui.js"

export default Plugin.define({
  id: "opencode.permission-review",
  setup(context) {
    const rpc = context.client.rpc(Contract)
    const current = () => {
      const route = context.ui.router.current()
      if (route.type !== "session") return
      return { sessionID: route.sessionID, location: context.data.session.get(route.sessionID)?.location }
    }
    const location = () => current()?.location ?? context.location ?? context.data.location.default()
    const options = () => ({ location: location() })
    const openSession = async () => {
      const session = current()
      if (session) return session
      const created = await context.client.session.create({ location: location() })
      await context.data.session.sync(created.id)
      context.ui.router.navigate({ type: "session", sessionID: created.id })
      return { sessionID: created.id, location: created.location }
    }
    const requirePrompts = () => {
      const mode = context.ui.experimental?.permissions.mode()
      if (mode === "prompt") return
      throw new Error(
        mode
          ? "Turn off auto accept: open /settings → Session → Permissions and select Prompt. Restart without --auto if needed. Keep other connected clients in Prompt mode too."
          : "Update the OpenCode client: this plugin requires the experimental permission-mode API.",
      )
    }
    const requireSession = () => {
      const session = current()
      if (!session) throw new Error("No session selected")
      return session
    }
    context.ui.experimental?.permissions.action?.({
      id: "allow-session",
      title: "Allow Session",
      description: "Remember this example. Future requests still reviewed.",
      enabled: () => context.ui.experimental?.permissions.mode() === "prompt",
      async run(request) {
        await rpc.allowSession(
          { sessionID: request.sessionID, requestID: request.id },
          {
            location: context.data.session.get(request.sessionID)?.location,
          },
        )
        context.ui.toast.show({ message: "Approved and remembered for this session", variant: "info" })
      },
    })
    const [revision, setRevision] = createSignal(0)
    const refresh = () => {
      setRevision((value) => value + 1)
    }
    onCleanup(
      context.data.listen((event) => {
        if (
          [
            "rpc.opencode.permission-review.settingsChanged",
            "rpc.opencode.permission-review.changed",
            "server.connected",
          ].includes(event.details.type)
        )
          refresh()
      }),
    )
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "permission-review.permissions",
          title: "Permissions",
          description: "Choose permissions and configure automatic review",
          group: "Session",
          palette: true,
          slash: { name: "permissions" },
          enabled: () => ["home", "session"].includes(context.ui.router.current().type),
          run() {
            context.ui.dialog.show(() => (
              <PermissionSettings
                theme={context.theme}
                keymap={context.keymap}
                revision={revision()}
                onClose={() => context.ui.dialog.clear()}
                actions={{
                  settings: () => rpc.settings({}, options()),
                  save: (input) => rpc.saveSettings(input, options()),
                  session: async () => {
                    const session = current()
                    return session ? rpc.session({ sessionID: session.sessionID }, options()) : undefined
                  },
                  change: async (change) => {
                    requirePrompts()
                    const session = change.type === "preset" ? await openSession() : requireSession()
                    return rpc.setSession({ sessionID: session.sessionID, change }, { location: session.location })
                  },
                  models: async () =>
                    (await context.client.model.list({ types: ["chat", "decision"], location: location() })).data,
                  exportDiagnostics: async (file) => {
                    if (!file.trim()) throw new Error("Enter a file path")
                    const records = await rpc.exportDiagnostics({ sessionID: requireSession().sessionID }, options())
                    const handle = await open(file.trim(), "wx", 0o600)
                    try {
                      await handle.writeFile(JSON.stringify({ format: 1, records }, null, 2) + "\n")
                    } finally {
                      await handle.close()
                    }
                  },
                  history: () => rpc.history({ sessionID: requireSession().sessionID }, options()),
                  approvals: () => rpc.approvals({ sessionID: requireSession().sessionID }, options()),
                  revoke: (requestID) => rpc.revoke({ sessionID: requireSession().sessionID, requestID }, options()),
                }}
              />
            ))
            context.ui.dialog.set({ size: "medium" })
          },
        },
      ],
    }))
    context.ui.slot({
      append: "prompt.footer.status",
      render() {
        const [state, setState] = createSignal<State>()
        const load = async () => {
          const session = current()
          if (!session) return setState(undefined)
          const next = await rpc.session({ sessionID: session.sessionID }, { location: session.location })
          if (current()?.sessionID === session.sessionID) setState(next)
        }
        createEffect(() => {
          revision()
          void load().catch(() => undefined)
        })
        return (
          <Show when={state()}>
            {(value) => (
              <text fg={context.theme.text.muted}>
                {context.ui.experimental?.permissions.mode() === "autoaccept"
                  ? "permissions: client auto accept"
                  : `permissions: ${scopeName(value())} · ${reviewLabels[value().mode]}`}
              </text>
            )}
          </Show>
        )
      },
    })
  },
})
