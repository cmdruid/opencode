import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Contract, type Assessment, type Preset, type ReviewMode, type State } from "./contract.js"

const labels = { manual: "Manual", shadow: "Shadow", auto: "Approve for me" } satisfies Record<ReviewMode, string>
const presets = {
  "read-only": { title: "Read only", description: "Read files; ask for edits and shell" },
  workspace: { title: "Ask for approval", description: "Local edits; ask for shell/network" },
  auto: { title: "Approve for me", description: "Local edits; model reviews requests" },
  shadow: { title: "Shadow", description: "Local edits; model suggests, you decide" },
  full: { title: "Full access", description: "Allow tools; denials still apply" },
  configured: { title: "Configured rules", description: "Reset rules and reviewer" },
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
          enabled: () => current() !== undefined,
          async run() {
            const session = current()
            if (!session) return
            await (async () => {
              const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
              const preset = await context.ui.dialog.select<Preset>({
                title: "Permissions — this session",
                current: state.preset,
                options: (Object.keys(presets) as Preset[]).map((value) => ({ value, ...presets[value] })),
                actions: [
                  {
                    bind: "ctrl+i",
                    title: "Details",
                    onTrigger: () =>
                      context.ui.dialog.alert({
                        title: "Active permissions",
                        message: [
                          `Preset: ${presets[state.preset].title}`,
                          `Reviewer: ${labels[state.mode]} (${state.model.providerID}/${state.model.id})`,
                          `Reviewed actions: ${state.actions?.join(", ") ?? "all requests needing approval"}`,
                          ...(state.inheritedFrom ? [`Inherited from: ${state.inheritedFrom}`] : []),
                          "",
                          "Explicit deny rules always apply. Local reads and edits keep configured approval requirements. Shell, network, outside-directory and other tool requests need approval in workspace presets.",
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
              if (preset !== "full" && !(await requirePrompts())) return
              if (preset === "full") {
                const confirmed = await context.ui.dialog.select({
                  title: "Enable full access?",
                  current: false,
                  options: [
                    { value: false, title: "Go back", description: "Keep current permissions" },
                    {
                      value: true,
                      title: "Enable full access",
                      description: "Shell, outside files, network",
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
          title: "Permission review mode",
          description: "Choose how this session handles requests that need approval",
          group: "Session",
          palette: true,
          slash: { name: "permission-review" },
          enabled: () => current() !== undefined,
          async run() {
            const session = current()
            if (!session) return
            await (async () => {
              const state = await rpc.get({ sessionID: session.sessionID }, { location: session.location })
              if (state.preset !== "configured") {
                context.keymap.dispatch("permission-review.permissions")
                return
              }
              const mode = await context.ui.dialog.select<ReviewMode>({
                title: "Permission review — this session",
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
                    : `permissions: ${presets[value().preset].title}`}
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
