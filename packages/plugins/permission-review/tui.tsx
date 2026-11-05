import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Contract, type Assessment, type Preset, type ReviewMode, type State } from "./contract.js"

const labels = { manual: "Manual", shadow: "Shadow", auto: "Approve for me" } satisfies Record<ReviewMode, string>
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

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "permission-review.approvals",
          title: "Session approvals",
          description: "Inspect or revoke examples remembered with Allow Session",
          group: "Session",
          palette: true,
          slash: { name: "session-approvals" },
          enabled: () => current() !== undefined,
          async run() {
            const session = current()
            if (!session) return
            await (async () => {
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
              await rpc.revoke(
                { sessionID: session.sessionID, requestID: selected.requestID },
                { location: session.location },
              )
              context.ui.toast.show({ message: "Session approval revoked", variant: "info" })
            })().catch(failure)
          },
        },
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
              const preset = await context.ui.dialog.select<Preset>({
                title: "Permissions — this session",
                current:
                  state.preset === "configured" ? undefined : state.preset === "shadow" ? "workspace" : state.preset,
                options: (["read-only", "workspace", "auto", "full"] as const).map((value) => ({
                  value,
                  ...presets[value],
                })),
                actions: [
                  {
                    bind: "ctrl+i",
                    title: "Details",
                    onTrigger: () =>
                      context.ui.dialog.alert({
                        title: "Active permissions",
                        message: [
                          `Preset: ${presets[state.preset === "shadow" ? "workspace" : state.preset].title}`,
                          `Reviewer: ${labels[state.mode]} (${state.model.providerID}/${state.model.id})`,
                          `Reviewed actions: ${state.actions?.join(", ") ?? "all requests needing approval"}`,
                          ...(state.inheritedFrom ? [`Inherited from: ${state.inheritedFrom}`] : []),
                          "",
                          "OpenCode's effective approval requirements and denials always apply. Presets can add approval requirements; Full access adds none. The selected reviewer handles requests that still need approval.",
                          "",
                          "Use /permissions-test to change the reviewer without changing scope. Shadow is available there for testing.",
                          "",
                          "Selections persist for this session and are inherited by subagents unless overridden there. Existing prompts and running reviews keep their current decision flow.",
                          "",
                          "These are tool approval rules, not an OS sandbox. Commands run with your account's filesystem and network access.",
                        ].join("\n"),
                      }),
                  },
                ],
              })
              if (!preset) return
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
        {
          id: "permission-review.mode",
          title: "Permissions test",
          description: "Choose a reviewer or Shadow testing without changing scope",
          group: "Session",
          palette: true,
          slash: { name: "permissions-test" },
          enabled: () => ["home", "session"].includes(context.ui.router.current().type),
          async run() {
            await (async () => {
              const session = await openSession()
              if (!session) return
              const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
              const mode = await context.ui.dialog.select<ReviewMode>({
                title: "Permissions test — this session",
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
            })().catch(failure)
          },
        },
        {
          id: "permission-review.history",
          title: "Permission review history",
          description: "Inspect this session's latest reviewer assessments",
          group: "Session",
          palette: true,
          slash: { name: "permission-reviews" },
          enabled: () => current() !== undefined,
          async run() {
            const session = current()
            if (!session) return
            await (async () => {
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
    "",
    entry.reason,
    "",
    "This records the review, not whether the tool executed or how the user replied.",
    `Request: ${entry.requestID}`,
  ].join("\n")
}
