import type { Plugin } from "@opencode/plugin/tui"
import { Model } from "@opencode/plugin/effect"
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { SelectRow } from "../../tui/src/ui/select-row"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, For, Show, untrack } from "solid-js"
import { percent } from "./contract.js"
import type {
  Assessment,
  ConnectionRole,
  FallbackMode,
  Overrides,
  ReviewMode,
  ReviewWith,
  SaveSettings,
  ServerSettings,
  SessionApproval,
  State,
} from "./contract.js"

export const reviewLabels = { manual: "Manual", shadow: "Shadow", auto: "Approve" }
export const reviewWithLabels = { classifier: "Classifier", reviewer: "Reviewer", both: "Both" }
export const fallbackLabels = { off: "Off", shadow: "Shadow", auto: "Approve" }
export const presets = {
  "read-only": { title: "Read only", description: "Read files; ask for edits and shell" },
  workspace: { title: "Ask for approval", description: "Local edits; ask for shell and network" },
  auto: { title: "Approve", description: "Local edits; model reviews requests" },
  full: { title: "Full access", description: "Configured limits still apply" },
}
export type SessionChange =
  | { type: "preset"; preset: keyof typeof presets }
  | { type: "automation"; mode: typeof ReviewWith.Type }
  | { type: "reviewer"; mode: ReviewMode }
  | { type: "fallback"; mode: FallbackMode }
  | { type: "reset"; target: "selection" | "fallback" | "automation" }

export interface SettingsActions {
  settings(): Promise<ServerSettings>
  save(input: SaveSettings): Promise<ServerSettings>
  session(): Promise<State | undefined>
  change(input: SessionChange): Promise<State>
  models(): Promise<readonly { providerID: string; id: string; type?: string; variants: readonly { id: string }[] }[]>
  exportDiagnostics(file: string): Promise<void>
  history(): Promise<readonly Assessment[]>
  approvals(): Promise<readonly SessionApproval[]>
  revoke(requestID: string): Promise<void>
}

type Row = { title: string; value?: string; detail?: string; current?: boolean; run(): void | Promise<void> }
type Page =
  | {
      type: "menu"
      title: string
      scope: string | (() => string)
      rows(): Row[]
      selected: number
      scroll: number
    }
  | { type: "editor"; title: string; value: string; submit(value: string): void | Promise<void> }
  | { type: "detail"; title: string; text: string }

/** One production view for the companion, isolated renderer tests, and story fixtures. */
export function PermissionSettings(props: {
  theme: Plugin.Context["theme"]
  actions: SettingsActions
  keymap?: Plugin.Context["keymap"]
  revision?: number
  onClose(): void
}) {
  const theme = props.theme.surface("dialog")
  const dimensions = useTerminalDimensions()
  const width = () => Math.min(60, dimensions().width - 2)
  const [server, setServer] = createSignal<ServerSettings>()
  const [session, setSession] = createSignal<State>()
  const [busy, setBusy] = createSignal(true)
  const [error, setError] = createSignal("")
  const [pages, setPages] = createSignal<Page[]>([])
  let target: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let editor: TextareaRenderable | undefined
  const page = () => pages().at(-1)
  const rows = () => {
    const current = page()
    return current?.type === "menu" ? current.rows() : []
  }
  const values = () => server()!.values
  const source = (key: keyof Overrides) => `All sessions · ${server()?.sources[key]}`
  const back = () => {
    setError("")
    if (pages().length <= 1) return props.onClose()
    setPages((items) => items.slice(0, -1))
  }
  props.keymap?.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
      { bind: "ctrl+r", title: "Reset to Defaults", run: () => resetDefaults() },
      {
        bind: "escape",
        title: "Back",
        run: () => {
          if (!busy()) back()
        },
      },
    ],
  }))
  const push = (next: Page) => {
    const current = page()
    if (current?.type === "menu") current.scroll = scroll?.scrollTop ?? 0
    setError("")
    setPages((items) => [...items, next])
  }
  const menu = (title: string, scope: string | (() => string), entries: () => Row[]) =>
    push({ type: "menu", title, scope, rows: entries, selected: 0, scroll: 0 })
  const detail = (title: string, text: string) => push({ type: "detail", title, text })
  const edit = (title: string, initial: string, submit: (text: string) => void | Promise<void>) =>
    push({ type: "editor", title, value: initial, submit })
  const run = (action: () => void | Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setError("")
    void Promise.resolve()
      .then(action)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }
  const save = async (input: SaveSettings) => {
    setServer(await props.actions.save(input))
    setSession(await props.actions.session())
  }
  const patch = (input: Overrides) => save({ patch: input })
  const change = async (input: SessionChange) => {
    setSession(await props.actions.change(input))
  }
  const choose = <Value extends string>(
    title: string,
    scope: string,
    choices: readonly Value[],
    label: (item: Value) => string,
    submit: (item: Value) => Promise<void>,
  ) =>
    menu(title, scope, () =>
      choices.map((item) => ({
        title: label(item),
        detail: item === "shadow" ? "Suggest only; you decide whether to approve" : undefined,
        run: async () => {
          await submit(item)
          back()
        },
      })),
    )
  const resetScope = () => {
    if (page()?.type !== "menu" || page()?.title === "Reset to Defaults?" || page()?.title === "Reset to Defaults")
      return
    if (page()?.title === "Permission settings") return "Permission settings"
    return pages().findLast((item) =>
      [
        "Classifier connection",
        "Reviewer connection",
        "Classifier",
        "Reviewer",
        "Session Policy",
        "Global Policy",
        "Review Rules",
      ].includes(item.title),
    )?.title
  }
  const resetDefaults = (section?: string): void => {
    const scope = section ?? resetScope()
    if (!scope || (busy() && !section)) return
    if (scope === "Permission settings")
      return menu("Reset to Defaults", "Choose which settings to restore", () =>
        ["Classifier", "Reviewer", "Global Policy", "Review Rules", ...(session() ? ["Session Policy"] : [])].map(
          (title) => ({
            title,
            run: () => resetDefaults(title),
          }),
        ),
      )
    const depth = pages().length
    menu("Reset to Defaults?", `${scope}: configuration or built-in defaults`, () => [
      {
        title: "Cancel",
        detail: `${scope}: configuration or built-in defaults`,
        run: back,
      },
      {
        title: "Reset to Defaults",
        detail:
          scope === "Session Policy"
            ? "Remove session overrides; inherit parent and global policy"
            : `Restore ${scope} from configuration or built-in defaults`,
        run: async () => {
          if (scope === "Session Policy") {
            await change({ type: "reset", target: "automation" })
            await change({ type: "reset", target: "selection" })
            await change({ type: "reset", target: "fallback" })
          } else if (scope.endsWith("connection")) {
            await save({
              patch: {},
              connection: { role: scope === "Classifier connection" ? "classifier" : reviewerRole() },
            })
          } else {
            await save({
              patch: {},
              reset:
                scope === "Classifier"
                  ? ["model", "mode", "minConfidence"]
                  : scope === "Reviewer"
                    ? values().mode === "chat"
                      ? ["model", "mode", "fallback"]
                      : ["fallback"]
                    : scope === "Global Policy"
                      ? ["reviewWith", "defaultMode", "reviewerMode"]
                      : ["autoAllowTools", "workspaceReads", "actions", "policy"],
            })
          }
          setPages((items) => {
            const parent = items.findLastIndex((item) => item.title === scope)
            return items.slice(0, parent < 0 ? depth : parent + (scope.endsWith("connection") ? 0 : 1))
          })
        },
      },
    ])
  }
  const reviewerModel = () => (values().mode === "chat" ? values().model : values().fallback?.model)
  const reviewerRole = (): ConnectionRole => (values().mode === "chat" ? "classifier" : "fallback")
  const fallback = (input: Partial<NonNullable<Overrides["fallback"]>>) => {
    const current = values().fallback
    if (!current) throw new Error("Choose a reviewer model first")
    return patch({ fallback: { ...current, ...input } })
  }
  const pickModel = async (role: ConnectionRole, provider = false) => {
    const models = (await props.actions.models()).filter(
      (item) => (item.type ?? "chat") === (role === "classifier" ? "decision" : "chat"),
    )
    const providers = [...new Set(models.map((model) => model.providerID))]
    const current =
      role === "classifier" ? (values().mode === "decision" ? values().model : undefined) : reviewerModel()
    const chooseProvider = provider || !current
    const depth = pages().length
    const list = (providerID?: string) =>
      menu("Choose model", role === "classifier" ? "Classifier models" : "Chat models", () =>
        models
          .filter((model) => !providerID || model.providerID === providerID)
          .map((model) => ({
            title: model.id,
            value: providerID ? undefined : model.providerID,
            run: async () => {
              const select = async (variant?: string) => {
                const ref = Model.Ref.parse(`${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`)
                await patch(
                  role === "classifier"
                    ? { mode: "decision", model: ref }
                    : values().mode === "chat"
                      ? { model: ref }
                      : { fallback: { mode: "shadow", timeoutMs: 10_000, ...values().fallback, model: ref } },
                )
                setPages((items) => items.slice(0, depth))
              }
              if (!model.variants.length) return select()
              menu("Choose variant", model.id, () => [
                {
                  title: "Default",
                  run: async () => {
                    await select()
                  },
                },
                ...model.variants.map((variant) => ({
                  title: variant.id,
                  run: async () => {
                    await select(variant.id)
                  },
                })),
              ])
            },
          })),
      )
    if (!chooseProvider) return list(current!.providerID)
    menu("Choose provider", role === "classifier" ? "Classifier" : "Reviewer", () =>
      providers.map((providerID) => ({ title: providerID, run: () => list(providerID) })),
    )
  }
  const connection = (
    role: ConnectionRole,
    title = role === "classifier" ? "Classifier connection" : "Reviewer connection",
  ) => {
    const saved = server()!.connections.find((item) => item.role === role)
    if (!saved) throw new Error("Choose a reviewer model first")
    const draft = { url: saved.url ?? "", auth: saved.custom && saved.authenticated ? "keep" : "none", key: "" }
    menu(title, "Draft · all sessions on this server", () => [
      {
        title: "Base URL",
        value: draft.url || "Not set",
        run: () =>
          edit("Base URL", draft.url, (text) => {
            draft.url = text
            back()
          }),
      },
      {
        title: "Authentication",
        value: draft.auth === "key" ? "New API key" : draft.auth === "keep" ? "Keep saved API key" : "No API key",
        run: () =>
          choose(
            "Authentication",
            "Draft",
            [...(saved.custom && saved.authenticated ? ["keep"] : []), "none", "key"],
            (item) => (item === "keep" ? "Keep saved API key" : item === "none" ? "No API key" : "Set API key"),
            async (item) => {
              draft.auth = item
            },
          ),
      },
      ...(draft.auth === "key"
        ? [
            {
              title: "API key",
              value: draft.key ? "New key entered" : "Not set",
              run: () =>
                edit("API key", "", (text) => {
                  draft.key = text
                  back()
                }),
            },
          ]
        : []),
      {
        title: "Save connection",
        run: async () => {
          if (draft.auth === "key" && !draft.key.trim()) throw new Error("Enter an API key or choose No API key")
          if (draft.auth === "keep" && draft.url.trim().replace(/\/+$/, "") !== saved.url)
            throw new Error("Endpoint changed: choose No API key or enter a new key")
          await save({
            patch: {},
            connection: {
              role,
              url: draft.url,
              ...(draft.auth === "keep" ? {} : { apiKey: draft.auth === "key" ? draft.key : "" }),
            },
          })
          back()
        },
      },
      { title: "Cancel", run: back },
    ])
  }
  const classifier = () =>
    menu("Classifier", "Fast decision model · all sessions", () => [
      {
        title: "Provider",
        value: values().mode === "decision" ? values().model.providerID : "Not configured",
        detail: `${modelName(values().model)} · ${server()?.sources.model}`,
        run: () => pickModel("classifier", true),
      },
      {
        title: "Model",
        value: values().mode === "decision" ? values().model.id : "Choose classifier",
        detail: `${modelName(values().model)} · ${server()?.sources.model}`,
        run: () => pickModel("classifier"),
      },
      {
        title: "Connection",
        value: server()!.connections.find((item) => item.role === "classifier")?.custom ? "Custom" : "Provider default",
        run: () => connection("classifier"),
      },
      {
        title: "Minimum approval score",
        value: percent(values().minConfidence),
        detail: `${source("minConfidence")} · minimum approval score; provider confidence is separate`,
        run: () =>
          edit("Minimum approval score (0–100%)", percent(values().minConfidence), async (text) => {
            const score = number(text.trim().replace(/%$/, ""))
            if (score < 0 || score > 100) throw new Error("Enter a percentage from 0 to 100")
            await patch({ minConfidence: score / 100 })
            back()
          }),
      },
    ])
  const reviewer = () =>
    menu("Reviewer", "Chat model · all sessions", () => [
      {
        title: "Provider",
        value: reviewerModel()?.providerID ?? "Not configured",
        run: () => pickModel("fallback", true),
      },
      {
        title: "Model",
        value: reviewerModel()?.id ?? "Not configured",
        detail: reviewerModel()
          ? `${modelName(reviewerModel()!)} · ${server()?.sources.fallback}`
          : "Choose a chat model",
        run: () => pickModel("fallback"),
      },
      ...(reviewerModel()
        ? [
            {
              title: "Connection",
              value: server()!.connections.find((item) => item.role === reviewerRole())?.custom
                ? "Custom"
                : "Provider default",
              run: () => connection(reviewerRole(), "Reviewer connection"),
            },
          ]
        : []),
      ...(values().mode === "decision" && values().fallback
        ? [
            {
              title: "Timeout (ms)",
              value: String(values().fallback!.timeoutMs),
              run: () =>
                edit("Reviewer timeout (100–15000 ms)", String(values().fallback!.timeoutMs), async (text) => {
                  await fallback({ timeoutMs: number(text) })
                  back()
                }),
            },
            { title: "Remove reviewer", run: () => patch({ fallback: null }) },
          ]
        : []),
    ])
  const actionCatalog = () => {
    const selected = new Set(
      values().actions ?? ["read", "edit", "shell", "webfetch", "websearch", "external_directory", "doom_loop"],
    )
    menu("Common actions", "Draft · exact action names", () => [
      ...["read", "edit", "shell", "webfetch", "websearch", "external_directory", "doom_loop"].map((action) => ({
        title: `${selected.has(action) ? "✓" : "○"} ${action}`,
        run: () => {
          selected.has(action) ? selected.delete(action) : selected.add(action)
          setPages((items) => [...items])
        },
      })),
      {
        title: "Save actions",
        run: async () => {
          await patch({ actions: [...selected] })
          back()
          back()
        },
      },
      { title: "Cancel", run: back },
    ])
  }
  const policy = () =>
    menu("Global Policy", "All sessions on this server", () => [
      {
        title: "Automation Mode",
        value: reviewWithLabels[values().reviewWith],
        detail: "Use either model, or consult the reviewer for uncertain classifier results",
        run: () =>
          choose(
            "Automation Mode",
            "All sessions on this server",
            ["classifier", "reviewer", "both"] as const,
            (item) => reviewWithLabels[item],
            (reviewWith) => patch({ reviewWith }),
          ),
      },
      {
        title: "Classifier Mode",
        value: reviewLabels[values().defaultMode],
        run: () =>
          choose(
            "Classifier Mode",
            "All sessions on this server",
            ["manual", "shadow", "auto"] as const,
            (item) => reviewLabels[item],
            (defaultMode) => patch({ defaultMode }),
          ),
      },
      {
        title: "Reviewer Mode",
        value: fallbackLabels[values().reviewerMode],
        run: () =>
          choose(
            "Reviewer Mode",
            "All sessions on this server",
            ["off", "shadow", "auto"] as const,
            (item) => fallbackLabels[item],
            (reviewerMode) => patch({ reviewerMode }),
          ),
      },
    ])
  const rules = () =>
    menu("Review Rules", "All sessions on this server", () => [
      ...(["skill", "todowrite"] as const).map((tool) => ({
        title: `Auto-allow ${tool}`,
        value: values().autoAllowTools.includes(tool) ? "On" : "Off",
        detail: "Skip model review in Approve mode; explicit denials still apply",
        run: () =>
          patch({
            autoAllowTools: values().autoAllowTools.includes(tool)
              ? values().autoAllowTools.filter((item) => item !== tool)
              : [...values().autoAllowTools, tool],
          }),
      })),
      {
        title: "Workspace reads",
        value: values().workspaceReads ? "Auto-allow" : "Review",
        detail: "Resolved paths inside the session directory; Approve mode only",
        run: () => patch({ workspaceReads: !values().workspaceReads }),
      },
      {
        title: "Reviewed actions",
        value:
          values().actions === null ? "All" : values().actions!.length ? `${values().actions!.length} actions` : "None",
        detail: source("actions"),
        run: () =>
          menu("Reviewed actions", "Exact action names; unreviewed requests ask the human", () => [
            {
              title: "All actions",
              run: async () => {
                await patch({ actions: null })
                back()
              },
            },
            { title: "Common actions", run: actionCatalog },
            {
              title: "Choose action names",
              run: () =>
                edit(
                  "Actions, comma separated (blank means none)",
                  values().actions?.join(", ") ?? "read, shell",
                  async (text) => {
                    await patch({
                      actions: [
                        ...new Set(
                          text
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        ),
                      ],
                    })
                    back()
                    back()
                  },
                ),
            },
          ]),
      },
      {
        title: "Additional instructions",
        value: values().policy ? "Custom" : "None",
        detail: source("policy"),
        run: () =>
          edit("Additional policy instructions", values().policy, async (policy) => {
            await patch({ policy })
            back()
          }),
      },
      { title: "Clear additional instructions", run: () => patch({ policy: "" }) },
    ])
  const sessionMenu = () =>
    menu(
      "Session Policy",
      () => (session() ? "Current session" : "No session selected; choose a preset to create one"),
      () =>
        session()
          ? [
              {
                title: "Automation Mode",
                value: reviewWithLabels[session()!.reviewWith ?? values().reviewWith],
                detail: `This session · ${session()!.reviewWithSource ?? "global policy"}`,
                run: () =>
                  choose(
                    "Automation Mode",
                    "This session; other sessions use Global Policy",
                    ["classifier", "reviewer", "both"] as const,
                    (item) => reviewWithLabels[item],
                    (mode) => change({ type: "automation", mode }),
                  ),
              },
              {
                title: "Classifier Mode",
                value: reviewLabels[session()!.mode],
                detail: `This session · ${session()!.modeSource}`,
                run: () =>
                  choose(
                    "Classifier Mode",
                    "This session · Shadow suggests only; you decide",
                    ["manual", "shadow", "auto"] as const,
                    (mode) => reviewLabels[mode],
                    (mode) => change({ type: "reviewer", mode }),
                  ),
              },
              {
                title: "Reviewer Mode",
                value: fallbackLabels[session()!.reviewerMode ?? session()!.fallback?.mode ?? values().reviewerMode],
                detail: `This session · ${session()!.fallbackSource}`,
                run: () =>
                  choose(
                    "Reviewer Mode",
                    "This session; children use Global Policy",
                    ["off", "shadow", "auto"] as const,
                    (mode) => fallbackLabels[mode],
                    (mode) => change({ type: "fallback", mode }),
                  ),
              },
            ]
          : [],
    )
  const activity = () =>
    menu(
      "Activity",
      () => (session() ? "Current session" : "No session selected"),
      () =>
        session()
          ? [
              {
                title: "Review history",
                run: async () => {
                  const entries = await props.actions.history()
                  menu("Review history", "Latest 50 completed assessments", () =>
                    entries.map((entry) => ({
                      title: `${entry.decision} · ${entry.action}`,
                      value: entry.shadow ? "Shadow proposal" : "Enforced decision",
                      run: () => detail("Permission assessment", describe(entry)),
                    })),
                  )
                },
              },
              {
                title: "Export diagnostics",
                detail: "Local JSON; redacted, but may contain task text and paths",
                run: () =>
                  edit("Export diagnostics to a new local file", "permission-diagnostics.json", async (file) => {
                    await props.actions.exportDiagnostics(file)
                    back()
                    detail("Diagnostics exported", `Saved to ${file}. Review the contents before sharing.`)
                  }),
              },
              {
                title: "Remembered approvals",
                run: async () => {
                  const entries = [...(await props.actions.approvals())]
                  menu("Remembered approvals", "This session; future requests are still reviewed", () =>
                    entries.map((entry) => ({
                      title: entry.action,
                      value: entry.resources.join(", "),
                      run: () =>
                        menu("Remembered approval", "Current session", () => [
                          {
                            title: "Details",
                            run: () => {
                              back()
                              detail("Remembered approval", JSON.stringify(entry, null, 2))
                            },
                          },
                          {
                            title: "Revoke approval",
                            run: async () => {
                              await props.actions.revoke(entry.requestID)
                              entries.splice(entries.indexOf(entry), 1)
                              back()
                            },
                          },
                        ]),
                    })),
                  )
                },
              },
              {
                title: "Effective permissions",
                run: () =>
                  detail(
                    "Effective permissions",
                    `${scopeName(session()!)}\nAutomation Mode: ${reviewWithLabels[session()!.reviewWith ?? values().reviewWith]}\nClassifier Mode: ${reviewLabels[session()!.mode]} (${session()!.modeSource})\nModel: ${modelName(session()!.model)}\nInherited from: ${session()!.inheritedFrom ?? "none"}\nReviewer: ${session()!.fallback ? fallbackLabels[session()!.fallback!.mode] : "inactive"} (${session()!.fallbackSource})\n\nConfigured approval requirements and denials always apply. Presets can add requirements; Full access adds none. These are tool approval policies, not an OS sandbox.`,
                  ),
              },
            ]
          : [],
    )
  const settingsMenu = () =>
    menu("Permission settings", "Choose a setting", () => [
      {
        title: "Classifier",
        value: values().mode === "decision" ? values().model.id : "Not configured",
        detail: "Fast decision model",
        run: classifier,
      },
      {
        title: "Reviewer",
        value: reviewerModel()?.id ?? "Not configured",
        detail: "Chat model for independent or combined review",
        run: reviewer,
      },
      {
        title: "Session Policy",
        value: session() ? reviewWithLabels[session()!.reviewWith ?? values().reviewWith] : "No session",
        detail: "Session permissions and automation",
        run: sessionMenu,
      },
      {
        title: "Global Policy",
        value: reviewWithLabels[values().reviewWith],
        detail: "Automation, classifier and reviewer defaults",
        run: policy,
      },
      { title: "Review Rules", detail: "Reviewed actions and additional instructions", run: rules },
      { title: "Activity", detail: "Review history, remembered approvals and effective permissions", run: activity },
    ])
  const root = () =>
    menu(
      "Permissions",
      () =>
        session()
          ? `${scopeName(session()!)} · ${reviewLabels[session()!.mode]}`
          : "Choose a preset for a new session, or configure the server",
      () => [
        ...(["read-only", "workspace", "auto", "full"] as const).map((preset) => ({
          title: presets[preset].title,
          current: matchesPreset(session(), preset),
          detail: presets[preset].description,
          run: async () => {
            if (preset === "full")
              return menu("Enable full access?", "Configured approval rules still apply", () => [
                { title: "Go back", run: back },
                {
                  title: "Enable full access",
                  run: async () => {
                    await change({ type: "preset", preset })
                    props.onClose()
                  },
                },
              ])
            await change({ type: "preset", preset })
            props.onClose()
          },
        })),
        { title: "Settings", detail: "Classifier, reviewer and permission options", run: settingsMenu },
      ],
    )
  createEffect(() => {
    props.revision
    untrack(() => {
      void Promise.all([props.actions.settings(), props.actions.session()])
        .then(([settings, state]) => {
          setServer(settings)
          setSession(state)
          if (!pages().length) {
            root()
            setBusy(false)
          }
        })
        .catch((cause: unknown) => {
          if (!pages().length) {
            menu("Permissions unavailable", "Close and reopen to retry", () => [{ title: "Close", run: props.onClose }])
            setBusy(false)
          }
          setError(cause instanceof Error ? cause.message : String(cause))
        })
    })
  })
  createEffect(() => {
    const current = page()
    if (current?.type === "editor") return
    target?.focus()
    scroll?.scrollTo(current?.type === "menu" ? current.scroll : 0)
  })
  const select = (index: number) => {
    const current = page()
    if (current?.type !== "menu" || busy()) return
    const next = Math.max(0, Math.min(rows().length - 1, index))
    if (next === current.selected) return
    setPages((items) => [...items.slice(0, -1), { ...current, selected: next, scroll: Math.max(0, next - 8) }])
  }
  return (
    <box width="100%" maxWidth={60} paddingBottom={1}>
      <box paddingLeft={3} paddingRight={3} marginBottom={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {page()?.title ?? "Permissions"}
        </text>
        <text
          fg={theme.text.muted}
          onMouseUp={() => {
            if (!busy()) back()
          }}
        >
          esc
        </text>
      </box>
      <Show when={page()} keyed>
        {(current) =>
          current.type === "editor" ? (
            <box paddingLeft={3} paddingRight={3}>
              <textarea
                keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
                initialValue={current.value}
                height={current.title === "Additional policy instructions" ? 5 : 1}
                wrapMode="word"
                textColor={theme.text.formfield.base}
                focusedTextColor={theme.text.formfield.base}
                ref={(item) => {
                  editor = item
                  queueMicrotask(() => {
                    if (!item.isDestroyed) item.focus()
                  })
                }}
                onSubmit={() => run(() => current.submit(editor?.plainText ?? ""))}
                onKeyDown={(event) => {
                  if (event.name === "escape") {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!busy()) back()
                  }
                  if (event.ctrl && event.name === "s") {
                    event.preventDefault()
                    event.stopPropagation()
                    run(() => current.submit(editor?.plainText ?? ""))
                  }
                }}
              />
              <text marginTop={1} fg={theme.text.muted}>
                ctrl+s save · esc cancel
              </text>
            </box>
          ) : (
            <box
              focusable
              ref={(item) => {
                target = item
                queueMicrotask(() => {
                  if (!item.isDestroyed) item.focus()
                })
              }}
              onKeyDown={(event) => {
                if (event.ctrl && event.name === "r" && event.eventType !== "release") {
                  event.preventDefault()
                  event.stopPropagation()
                  resetDefaults()
                  return
                }
                if (
                  event.eventType === "release" ||
                  !["escape", "up", "down", "return", "pageup", "pagedown", "home", "end"].includes(event.name)
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                if (busy()) return
                if (event.name === "escape") return back()
                if (current.type === "detail") {
                  scroll?.scrollBy(event.name === "pageup" || event.name === "up" ? -5 : 5)
                  return
                }
                if (event.name === "return") {
                  const row = rows()[current.selected]
                  if (row) run(row.run)
                  return
                }
                select(
                  event.name === "home"
                    ? 0
                    : event.name === "end"
                      ? rows().length - 1
                      : current.selected +
                        (event.name === "pageup" ? -8 : event.name === "pagedown" ? 8 : event.name === "up" ? -1 : 1),
                )
              }}
            >
              <scrollbox
                height={
                  current.type === "menu"
                    ? Math.max(1, Math.min(rows().length, 12, dimensions().height - 10))
                    : undefined
                }
                maxHeight={Math.max(3, Math.min(12, dimensions().height - 10))}
                paddingLeft={1}
                paddingRight={1}
                scrollbarOptions={{ visible: false }}
                ref={(item) => {
                  scroll = item
                }}
              >
                <Show when={current.type === "detail"}>
                  <box paddingLeft={2} paddingRight={2}>
                    <text fg={theme.text.base}>{current.type === "detail" ? current.text : ""}</text>
                  </box>
                </Show>
                <Show when={current.type === "menu"}>
                  <Show
                    when={rows().length}
                    fallback={
                      <box paddingLeft={2}>
                        <text fg={theme.text.muted}>No entries.</text>
                      </box>
                    }
                  >
                    <For each={rows()}>
                      {(row, index) => (
                        <box
                          id={`permission-row:${row.title}`}
                          height={1}
                          onMouseMove={() => select(index())}
                          onMouseDown={() => select(index())}
                          onMouseUp={() => run(row.run)}
                        >
                          <SelectRow
                            theme={theme}
                            inset={4}
                            title={row.title}
                            active={current.type === "menu" && index() === current.selected}
                            current={row.current ?? false}
                            titleWidth={Math.max(
                              10,
                              width() - 12 - (row.value ? Math.min(22, row.value.length, Math.floor(width() / 3)) : 0),
                            )}
                            footer={row.value ? shorten(row.value, Math.min(22, Math.floor(width() / 3))) : undefined}
                          />
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>
              </scrollbox>
              <Show when={current.type === "menu"}>
                <box paddingLeft={3} paddingRight={3} marginTop={1}>
                  <text maxHeight={2} fg={theme.text.muted}>
                    {rows()[current.type === "menu" ? current.selected : 0]?.detail ??
                      (current.type === "menu"
                        ? typeof current.scope === "function"
                          ? current.scope()
                          : current.scope
                        : "")}
                  </text>
                </box>
              </Show>
            </box>
          )
        }
      </Show>
      <Show when={resetScope()}>
        <box paddingLeft={3} paddingRight={3} marginTop={1}>
          <text fg={theme.text.muted}>ctrl+r Reset to Defaults</text>
        </box>
      </Show>
      <Show when={error()}>
        <box paddingLeft={3} paddingRight={3} marginTop={1}>
          <text fg={theme.text.feedback.error.base}>{error()}</text>
        </box>
      </Show>
      <Show when={busy()}>
        <box paddingLeft={3}>
          <text fg={theme.text.muted}>Loading…</text>
        </box>
      </Show>
    </box>
  )
}

function shorten(value: string, length: number) {
  return value.length > length ? value.slice(0, length - 1) + "…" : value
}

function number(value: string) {
  if (!value.trim() || !Number.isFinite(Number(value))) throw new Error("Enter a number")
  return Number(value)
}

function modelName(model: { providerID: string; id: string; variant?: string }) {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function scopeName(state: State) {
  if (state.preset === "read-only") return "Read only"
  if (state.preset === "full" || state.preset === "configured") return "Configured limits"
  return "Local edits; ask for shell and network"
}

export function matchesPreset(state: State | undefined, preset: keyof typeof presets) {
  if (!state) return false
  if (preset === "read-only") return state.preset === "read-only" && state.mode === "manual"
  if (preset === "full") return ["full", "configured"].includes(state.preset) && state.mode === "manual"
  return (
    ["workspace", "auto", "shadow"].includes(state.preset) && state.mode === (preset === "auto" ? "auto" : "manual")
  )
}

export function describe(entry: Assessment) {
  return [
    `${entry.shadow ? "Shadow proposal" : "Reviewer decision"}: ${entry.decision}`,
    ...(entry.summary || entry.fallback?.summary ? [`Summary: ${entry.fallback?.summary || entry.summary}`] : []),
    ...(entry.details || entry.fallback?.details ? [entry.fallback?.details || entry.details!] : []),
    ...(entry.path ? [`Decision path: ${entry.path}`] : []),
    ...(entry.reply ? [`Reply: ${entry.reply.decision}`] : []),
    `Action: ${entry.action}`,
    `Resources: ${entry.resources?.join(", ") ?? "none"}`,
    `Reviewer: ${modelName(entry.model)}`,
    `Time: ${new Date(entry.at).toLocaleString()} (${entry.durationMs} ms)`,
    ...(entry.classifier
      ? [
          `Raw choice: ${entry.classifier.choice}`,
          ...(entry.classifier.thresholdMetric === "approval-score"
            ? [
                `Approval score: ${entry.classifier.approvalScore === undefined ? "missing" : percent(entry.classifier.approvalScore)}; minimum: ${percent(entry.classifier.threshold)}`,
                `Provider confidence: ${percent(entry.classifier.confidence)}`,
              ]
            : [
                `Confidence: ${percent(entry.classifier.confidence)}; threshold: ${percent(entry.classifier.threshold)}`,
              ]),
          `Choice scores: ${entry.classifier.probabilities.map((item) => `${item.value} ${percent(item.probability)}`).join(", ")}`,
        ]
      : []),
    ...(entry.fallback
      ? [
          `Reviewer: ${modelName(entry.fallback.model)} · ${entry.fallback.mode}`,
          `${entry.fallback.trigger === "low-confidence" && entry.classifier?.thresholdMetric === "approval-score" ? "Below minimum approval score" : entry.fallback.trigger} · ${entry.fallback.status} · ${entry.fallback.durationMs} ms`,
          `${entry.fallback.decision}: ${entry.fallback.reason}`,
          entry.fallback.applied ? "Used in reviewer decision" : "Did not change reviewer decision",
        ]
      : []),
    entry.reason,
    "This records the review, not whether the tool executed or how the user replied.",
    `Request: ${entry.requestID}`,
  ].join("\n")
}
