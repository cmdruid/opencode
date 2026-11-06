import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import {
  Contract,
  type Assessment,
  type ConnectionRole,
  type FallbackMode,
  type Preset,
  type ReviewMode,
  type State,
} from "./contract.js"

const labels = { manual: "Manual", shadow: "Shadow", auto: "Approve for me" } satisfies Record<ReviewMode, string>
const fallbackLabels = { off: "Off", shadow: "Shadow", auto: "Automatic" } satisfies Record<FallbackMode, string>
const presets = {
  "read-only": { title: "Read only", description: "Read files; ask for edits and shell" },
  workspace: { title: "Ask for approval", description: "Local edits; ask for shell/network" },
  auto: { title: "Approve for me", description: "Local edits; model reviews requests" },
  shadow: { title: "Shadow", description: "Local edits; model suggests, you decide" },
  full: { title: "Full access", description: "Configured limits still apply" },
  configured: { title: "No additional restrictions", description: "Use OpenCode's effective permissions" },
} satisfies Record<Preset, { title: string; description: string }>

export default Plugin.define({
  id: "opencode.permission-review",
  setup(context) {
    const rpc = context.client.rpc(Contract)
    const current = () => {
      const route = context.ui.router.current()
      if (route.type !== "session") return
      return { sessionID: route.sessionID, location: context.data.session.get(route.sessionID)?.location }
    }
    const openSession = async () => {
      const session = current()
      if (session) return session
      if (context.ui.router.current().type !== "home") return
      // Create only the session record: permissions are selected before its first prompt.
      const created = await context.client.session.create({
        location: context.location ?? context.data.location.default(),
      })
      await context.data.session.sync(created.id)
      context.ui.router.navigate({ type: "session", sessionID: created.id })
      return { sessionID: created.id, location: created.location }
    }
    const failure = (error: unknown) =>
      context.ui.toast.show({
        title: "Permission review",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    const requirePrompts = async () => {
      const mode = context.ui.experimental?.permissions.mode()
      if (mode === "prompt") return true
      await context.ui.dialog.alert({
        title: mode ? "Turn off auto accept" : "Update the OpenCode client",
        message: mode
          ? "Open /settings → Session → Permissions and select Prompt. If started with --auto, restart without it. Auto accept answers permission prompts automatically, including reviewer escalations. Keep other connected clients in Prompt mode too."
          : "This selector needs a client with the experimental permission-mode API. Rebuild the fork and reconnect before choosing a preset.",
      })
      return false
    }

    context.ui.experimental?.permissions.action?.({
      id: "allow-session",
      title: "Allow Session",
      description: "Remember this example. Future requests still reviewed.",
      enabled: () => context.ui.experimental?.permissions.mode() === "prompt",
      async run(request) {
        await rpc.allowSession(
          { sessionID: request.sessionID, requestID: request.id },
          { location: context.data.session.get(request.sessionID)?.location },
        )
        context.ui.toast.show({ message: "Approved and remembered for this session", variant: "info" })
      },
    })

    async function showApprovals(session: NonNullable<ReturnType<typeof current>>) {
      const entries = await rpc.approvals({ sessionID: session.sessionID }, { location: session.location })
      if (!entries.length) {
        await context.ui.dialog.alert({
          title: "Session approvals",
          message:
            "No remembered approvals. Choose Allow Session on a permission prompt to save an example for this session's reviewer.",
        })
        return
      }
      const selected = await context.ui.dialog.select({
        title: "Session approvals",
        options: entries.map((entry) => ({
          value: entry,
          title: entry.action,
          description: entry.resources.join(", "),
        })),
      })
      if (!selected) return
      const revoke = await context.ui.dialog.select({
        title: "Remembered approval",
        current: false,
        options: [
          { value: false, title: "Keep approval" },
          { value: true, title: "Revoke approval", description: "Stop including it in future reviews" },
        ],
        actions: [
          {
            bind: "ctrl+i",
            title: "Details",
            selection: "none",
            onTrigger: () =>
              void context.ui.dialog.alert({
                title: "Remembered approval",
                message: `${JSON.stringify(selected, null, 2)}\n\nUsed only as guidance in this session; future requests are still reviewed.`,
              }),
          },
        ],
      })
      if (!revoke) return
      await rpc.revoke({ sessionID: session.sessionID, requestID: selected.requestID }, { location: session.location })
      context.ui.toast.show({ message: "Session approval revoked", variant: "info" })
    }

    async function showReviewer(session: NonNullable<ReturnType<typeof current>>) {
      const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
      const mode = await context.ui.dialog.select<ReviewMode>({
        title: "Reviewer mode — this session",
        current: state.mode,
        options: [
          { value: "manual", title: labels.manual, description: "Use existing permission prompts" },
          { value: "shadow", title: labels.shadow, description: "Suggest; you decide" },
          {
            value: "auto",
            title: labels.auto,
            description: "Approve, deny, or ask you",
          },
        ],
      })
      if (!mode || mode === state.mode) return
      if (!(await requirePrompts())) return
      await rpc.set({ sessionID: session.sessionID, mode }, { location: session.location })
      context.ui.toast.show({ message: `Permission review: ${labels[mode]}`, variant: "info" })
    }

    async function showHistory(session: NonNullable<ReturnType<typeof current>>) {
      const entries = await rpc.history({ sessionID: session.sessionID }, { location: session.location })
      if (entries.length === 0) {
        await context.ui.dialog.alert({
          title: "Permission review history",
          message:
            "No completed assessments for this session. Manual mode and existing permission rules do not call the reviewer.",
        })
        return
      }
      const selected = await context.ui.dialog.select({
        title: "Permission reviews — latest 50",
        options: entries.map((entry) => ({
          value: entry,
          title: `${entry.decision} · ${entry.action}`,
          description: entry.resources?.join(", ") ?? entry.requestID,
          footer: entry.shadow ? "shadow" : "enforced",
        })),
      })
      if (!selected) return
      await context.ui.dialog.alert({ title: "Permission assessment", message: describe(selected) })
    }

    async function showFallback(session: NonNullable<ReturnType<typeof current>>) {
      const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
      if (!state.fallback) {
        await context.ui.dialog.alert({
          title: "Chat fallback",
          message: "Configure a fallback model in the decision reviewer's plugin options first.",
        })
        return
      }
      const mode = await context.ui.dialog.select<FallbackMode>({
        title: "Chat fallback — this session",
        current: state.fallback.mode,
        options: [
          { value: "off", title: fallbackLabels.off, description: "Use only the classifier" },
          { value: "shadow", title: fallbackLabels.shadow, description: "Record a second opinion; still ask you" },
          { value: "auto", title: fallbackLabels.auto, description: "Approve only when both models agree" },
        ],
      })
      if (!mode || mode === state.fallback.mode) return
      if (!(await requirePrompts())) return
      await rpc.setFallback({ sessionID: session.sessionID, mode }, { location: session.location })
      context.ui.toast.show({ message: `Chat fallback: ${fallbackLabels[mode]}`, variant: "info" })
    }

    async function showConnection(session: NonNullable<ReturnType<typeof current>>, role: ConnectionRole) {
      const entries = await rpc.connections({}, { location: session.location })
      const entry = entries.find((entry) => entry.role === role)
      const title = role === "classifier" ? "Classifier connection" : "Chat fallback connection"
      if (!entry) {
        await context.ui.dialog.alert({ title, message: "Configure the reviewer's fallback model first." })
        return
      }
      const action = await context.ui.dialog.select({
        title: `${title} — all sessions`,
        options: [
          { value: "edit", title: "Edit connection", description: entry.url ?? "Use configured provider endpoint" },
          {
            value: "reset",
            title: "Use configured provider",
            description: `${entry.model.providerID}/${entry.model.id}`,
          },
        ],
      })
      if (!action) return
      if (action === "reset") {
        await rpc.setConnection({ role }, { location: session.location })
        context.ui.toast.show({ message: `${title}: configured provider restored`, variant: "info" })
        return
      }
      const url = await context.ui.dialog.prompt({
        title: `${title} — base URL`,
        description: "Applies to all sessions on this server. Include /v1 when required by the provider.",
        value: entry.url,
        placeholder: "http://127.0.0.1:28443/v1",
      })
      if (url === undefined) return
      const keep = entry.custom && entry.authenticated && url.trim().replace(/\/+$/, "") === entry.url
      const auth = await context.ui.dialog.select({
        title: `${title} — authentication`,
        current: keep ? "keep" : "none",
        options: [
          ...(keep ? [{ value: "keep", title: "Keep saved API key" }] : []),
          { value: "none", title: "No API key", description: "For a local proxy or an unauthenticated endpoint" },
          { value: "key", title: "Set API key", description: "Save in OpenCode's credential store" },
        ],
      })
      if (!auth) return
      const key =
        auth === "key"
          ? await context.ui.dialog.prompt({ title: `${title} — API key`, placeholder: "API key" })
          : undefined
      if (auth === "key" && key === undefined) return
      if (auth === "key" && !key?.trim()) throw new Error("Enter an API key or select No API key")
      await rpc.setConnection(
        { role, url, ...(auth === "keep" ? {} : { apiKey: key ?? "" }) },
        { location: session.location },
      )
      context.ui.toast.show({ message: `${title} saved for all sessions`, variant: "info" })
    }

    const showDetails = (state: State) =>
      context.ui.dialog.alert({
        title: "Active permissions",
        message: [
          `Preset: ${presets[state.preset === "shadow" ? "workspace" : state.preset].title}`,
          `Reviewer: ${labels[state.mode]} (${state.model.providerID}/${state.model.id})`,
          `Reviewed actions: ${state.actions?.join(", ") ?? "all requests needing approval"}`,
          ...(state.fallback
            ? [
                `Chat fallback: ${fallbackLabels[state.fallback.mode]} (${state.fallback.model.providerID}/${state.fallback.model.id}${state.fallback.model.variant ? `#${state.fallback.model.variant}` : ""}, ${state.fallback.timeoutMs} ms)`,
                "Fallback overrides apply only to this session; children use the configured default.",
              ]
            : []),
          ...(state.inheritedFrom ? [`Inherited from: ${state.inheritedFrom}`] : []),
          "",
          "OpenCode's effective approval requirements and denials always apply. Presets can add approval requirements; Full access adds none. The selected reviewer handles requests that still need approval.",
          "",
          "Open Settings → Reviewer mode to change the reviewer without changing scope. Shadow is available there for testing.",
          "",
          "Selections persist for this session and are inherited by subagents unless overridden there. Existing prompts and running reviews keep their current decision flow.",
          "",
          "These are tool approval rules, not an OS sandbox. Commands run with your account's filesystem and network access.",
        ].join("\n"),
      })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "permission-review.permissions",
          title: "Permissions",
          description: "Choose permissions and approval handling for this session",
          group: "Session",
          palette: true,
          slash: { name: "permissions" },
          enabled: () => ["home", "session"].includes(context.ui.router.current().type),
          async run() {
            await (async () => {
              const session = await openSession()
              if (!session) return
              const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
              const preset = await context.ui.dialog.select<Preset | "settings">({
                title: "Permissions — this session",
                current:
                  state.preset === "configured" ? undefined : state.preset === "shadow" ? "workspace" : state.preset,
                options: [
                  ...(["read-only", "workspace", "auto", "full"] as const).map((value) => ({
                    value,
                    ...presets[value],
                  })),
                  { value: "settings", title: "Settings", description: "Reviewer, session approvals and history" },
                ],
                actions: [
                  {
                    bind: "ctrl+i",
                    title: "Details",
                    onTrigger: () => showDetails(state),
                  },
                ],
              })
              if (!preset) return
              if (preset === "settings") {
                const setting = await context.ui.dialog.select({
                  title: "Permission settings",
                  options: [
                    { value: "mode", title: "Reviewer mode", description: "Manual, Shadow or Approve for me" },
                    { value: "fallback", title: "Chat fallback", description: "Second opinion for uncertain requests" },
                    {
                      value: "classifier-connection",
                      title: "Classifier connection",
                      description: "Endpoint and API key · all sessions",
                    },
                    {
                      value: "fallback-connection",
                      title: "Chat fallback connection",
                      description: "Endpoint and API key · all sessions",
                    },
                    {
                      value: "approvals",
                      title: "Session approvals",
                      description: "Inspect or revoke remembered examples",
                    },
                    {
                      value: "history",
                      title: "Review history",
                      description: "Recent decisions and classifier scores",
                    },
                    {
                      value: "details",
                      title: "Active permissions",
                      description: "Current scope, reviewer and inheritance",
                    },
                  ],
                })
                if (setting === "mode") await showReviewer(session)
                if (setting === "fallback") await showFallback(session)
                if (setting === "classifier-connection") await showConnection(session, "classifier")
                if (setting === "fallback-connection") await showConnection(session, "fallback")
                if (setting === "approvals") await showApprovals(session)
                if (setting === "history") await showHistory(session)
                if (setting === "details") await showDetails(state)
                return
              }
              if (!(await requirePrompts())) return
              if (preset === "full") {
                const confirmed = await context.ui.dialog.select({
                  title: "Enable full access?",
                  current: false,
                  options: [
                    { value: false, title: "Go back", description: "Keep current permissions" },
                    {
                      value: true,
                      title: "Enable full access",
                      description: "Keep configured approval rules",
                    },
                  ],
                })
                if (!confirmed) return
              }
              await rpc.select({ sessionID: session.sessionID, preset }, { location: session.location })
              context.ui.toast.show({ message: `Permissions: ${presets[preset].title}`, variant: "info" })
            })().catch(failure)
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
          setState(undefined)
          if (!session) return
          const next = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
          if (current()?.sessionID === session.sessionID) setState(next)
        }
        createEffect(() => void load().catch(() => undefined))
        onCleanup(context.data.on("server.connected", () => void load().catch(() => undefined)))
        onCleanup(
          rpc.events.on("changed", (event) => {
            if (event.data.sessionID === current()?.sessionID) setState(event.data.state)
            else void load().catch(() => undefined)
          }),
        )
        return (
          <Show when={state()}>
            {(value) => (
              <text fg={context.theme.text.muted}>
                {context.ui.experimental?.permissions.mode() === "autoaccept"
                  ? "permissions: client auto accept"
                  : value().preset === "configured"
                    ? `review: ${labels[value().mode]}`
                    : `permissions: ${presets[value().preset].title}${
                        (value().preset === "read-only" || value().preset === "full") && value().mode !== "manual"
                          ? ` · ${labels[value().mode]}`
                          : ""
                      }`}
              </text>
            )}
          </Show>
        )
      },
    })
  },
})

function describe(entry: Assessment) {
  return [
    `${entry.shadow ? "Shadow proposal" : "Reviewer decision"}: ${entry.decision}`,
    `Action: ${entry.action}`,
    ...(entry.resources ? [`Resources: ${entry.resources.join(", ")}`] : []),
    `Reviewer: ${entry.model.providerID}/${entry.model.id}`,
    `Time: ${new Date(entry.at).toLocaleString()} (${entry.durationMs} ms)`,
    ...(entry.classifier
      ? [
          `Raw choice: ${entry.classifier.choice}`,
          `Confidence: ${entry.classifier.confidence}; threshold: ${entry.classifier.threshold}`,
          `Choice scores: ${entry.classifier.probabilities.map((item) => `${item.value} ${item.probability}`).join(", ")}`,
        ]
      : []),
    ...(entry.fallback
      ? [
          `Chat fallback: ${fallbackLabels[entry.fallback.mode]} · ${entry.fallback.decision} (${entry.fallback.status}, ${entry.fallback.durationMs} ms)`,
          `Fallback model: ${entry.fallback.model.providerID}/${entry.fallback.model.id}${entry.fallback.model.variant ? `#${entry.fallback.model.variant}` : ""}`,
          `Trigger: ${entry.fallback.trigger}; ${entry.fallback.applied ? "used in reviewer decision" : "did not change reviewer decision"}`,
          `Second opinion: ${entry.fallback.reason}`,
        ]
      : []),
    "",
    entry.reason,
    "",
    "This records the review, not whether the tool executed or how the user replied.",
    `Request: ${entry.requestID}`,
  ].join("\n")
}
