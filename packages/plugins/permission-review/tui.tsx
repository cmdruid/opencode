import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Contract, type Assessment, type ReviewMode, type State } from "./contract.js"

const labels = { manual: "Manual", shadow: "Shadow", auto: "Approve for me" } satisfies Record<ReviewMode, string>

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

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
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
          }),
        )
        return (
          <Show when={state()}>
            <text fg={context.theme.text.muted}>review: {labels[state()?.mode ?? "manual"]}</text>
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
