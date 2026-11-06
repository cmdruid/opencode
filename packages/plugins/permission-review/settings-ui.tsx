import type { Plugin } from "@opencode/plugin/tui"
import { Model } from "@opencode/plugin/effect"
import type { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createEffect, createSignal, For, Show, untrack } from "solid-js"
import type {
  Assessment,
  ConnectionRole,
  FallbackMode,
  Overrides,
  ReviewMode,
  SaveSettings,
  ServerSettings,
  SessionApproval,
  State,
} from "./contract.js"

export const reviewLabels = { manual: "Manual", shadow: "Shadow — suggest only; you decide", auto: "Approve for me" }
export const fallbackLabels = { off: "Off", shadow: "Shadow — suggest only; you decide", auto: "Automatic" }
export const presets = {
  "read-only": { title: "Read only", description: "Read files; ask for edits and shell" },
  workspace: { title: "Ask for approval", description: "Local edits; ask for shell and network" },
  auto: { title: "Approve for me", description: "Local edits; model reviews requests" },
  full: { title: "Full access", description: "Configured limits still apply" },
}
export type SessionChange =
  | { type: "preset"; preset: keyof typeof presets }
  | { type: "reviewer"; mode: ReviewMode }
  | { type: "fallback"; mode: FallbackMode }
  | { type: "reset"; target: "selection" | "fallback" }

export interface SettingsActions {
  settings(): Promise<ServerSettings>
  save(input: SaveSettings): Promise<ServerSettings>
  session(): Promise<State | undefined>
  change(input: SessionChange): Promise<State>
  models(): Promise<readonly { providerID: string; id: string; type?: string; variants: readonly { id: string }[] }[]>
  history(): Promise<readonly Assessment[]>
  approvals(): Promise<readonly SessionApproval[]>
  revoke(requestID: string): Promise<void>
}

type Row = { title: string; value?: string; run(): void | Promise<void> }
type Page =
  | {
      type: "menu"
      title: string
      scope: string | (() => string)
      rows(): Row[]
      selected: number
      scroll: number
      query: string
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
    return current?.type === "menu"
      ? current.rows().filter((row) => row.title.toLowerCase().includes(current.query.toLowerCase()))
      : []
  }
  const values = () => server()!.values
  const value = (key: keyof Overrides, text: string) => `${text} · ${server()?.sources[key]}`
  const back = () => {
    setError("")
    if (pages().length <= 1) return props.onClose()
    setPages((items) => items.slice(0, -1))
  }
  props.keymap?.layer(() => ({
    mode: "modal",
    priority: 1,
    commands: [
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
    push({ type: "menu", title, scope, rows: entries, selected: 0, scroll: 0, query: "" })
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
        run: async () => {
          await submit(item)
          back()
        },
      })),
    )
  const reset = (keys: SaveSettings["reset"]): Row => ({
    title: "Use configured values",
    run: () => save({ patch: {}, reset: keys }),
  })
  const fallback = (input: Partial<NonNullable<Overrides["fallback"]>>) => {
    const current = values().fallback
    if (!current) throw new Error("Choose a second-opinion model first")
    return patch({ fallback: { ...current, ...input } })
  }
  const pickModel = async (role: ConnectionRole) => {
    const models = (await props.actions.models()).filter(
      (item) => (item.type ?? "chat") === (role === "fallback" ? "chat" : values().mode),
    )
    menu("Choose model", "All sessions on this server", () =>
      models.map((model) => ({
        title: `${model.providerID}/${model.id}`,
        run: () => {
          const select = async (variant?: string) => {
            const ref = Model.Ref.parse(`${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`)
            await patch(
              role === "classifier"
                ? { model: ref }
                : { fallback: { mode: "shadow", timeoutMs: 10_000, ...values().fallback, model: ref } },
            )
          }
          menu("Choose variant", "All sessions on this server", () => [
            {
              title: "Default",
              run: async () => {
                await select()
                back()
                back()
              },
            },
            ...model.variants.map((variant) => ({
              title: variant.id,
              run: async () => {
                await select(variant.id)
                back()
                back()
              },
            })),
          ])
        },
      })),
    )
  }
  const connection = (role: ConnectionRole) => {
    const saved = server()!.connections.find((item) => item.role === role)
    if (!saved) throw new Error("Choose a second-opinion model first")
    const draft = { url: saved.url ?? "", auth: saved.custom && saved.authenticated ? "keep" : "none", key: "" }
    menu(
      role === "classifier" ? "Primary reviewer connection" : "Second opinion connection",
      "Draft · all sessions on this server",
      () => [
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
        {
          title: "Use configured provider",
          run: async () => {
            await save({ patch: {}, connection: { role } })
            back()
          },
        },
        { title: "Cancel", run: back },
      ],
    )
  }
  const primary = () =>
    menu("Primary reviewer", "All sessions on this server", () => [
      {
        title: "Backend",
        value: value("mode", values().mode === "decision" ? "Classifier" : "Chat"),
        run: () =>
          menu("Backend", "Select a matching model", () =>
            (["chat", "decision"] as const).map((mode) => ({
              title: mode === "decision" ? "Classifier" : "Chat",
              run: async () => {
                // Backend and model are saved together so an intermediate incompatible choice cannot affect reviews.
                const models = (await props.actions.models()).filter((item) => (item.type ?? "chat") === mode)
                menu("Choose model for backend", "All sessions on this server", () =>
                  models.map((model) => ({
                    title: `${model.providerID}/${model.id}`,
                    run: async () => {
                      await patch({ mode, model: Model.Ref.parse(`${model.providerID}/${model.id}`) })
                      back()
                      back()
                    },
                  })),
                )
              },
            })),
          ),
      },
      {
        title: "Model and variant",
        value: value("model", modelName(values().model)),
        run: () => pickModel("classifier"),
      },
      {
        title: "Connection",
        value: server()!.connections.find((item) => item.role === "classifier")?.url ?? "Configured provider",
        run: () => connection("classifier"),
      },
      ...(values().mode === "decision"
        ? [
            {
              title: "Confidence threshold",
              value: value("minConfidence", String(values().minConfidence)),
              run: () =>
                edit(
                  "Confidence threshold (0–1, not a safety probability)",
                  String(values().minConfidence),
                  async (text) => {
                    await patch({ minConfidence: number(text) })
                    back()
                  },
                ),
            },
          ]
        : []),
      reset(["model", "mode", "minConfidence"]),
    ])
  const second = () =>
    menu(
      "Second opinion",
      () =>
        values().mode === "decision"
          ? "All sessions on this server"
          : "Inactive with a chat primary; saved setup is retained",
      () => [
        {
          title: "Model and variant",
          value: value("fallback", values().fallback ? modelName(values().fallback!.model) : "Not configured"),
          run: () => pickModel("fallback"),
        },
        ...(values().fallback
          ? [
              {
                title: "Connection",
                value: server()!.connections.find((item) => item.role === "fallback")?.url ?? "Configured provider",
                run: () => connection("fallback"),
              },
              {
                title: "Default mode",
                value: value("fallback", fallbackLabels[values().fallback!.mode]),
                run: () =>
                  choose(
                    "Second opinion default",
                    "All sessions on this server",
                    ["off", "shadow", "auto"] as const,
                    (item) => fallbackLabels[item],
                    (mode) => fallback({ mode }),
                  ),
              },
              {
                title: "Timeout (ms)",
                value: value("fallback", String(values().fallback!.timeoutMs)),
                run: () =>
                  edit("Second opinion timeout (100–15000 ms)", String(values().fallback!.timeoutMs), async (text) => {
                    await fallback({ timeoutMs: number(text) })
                    back()
                  }),
              },
              { title: "Remove second opinion", run: () => patch({ fallback: null }) },
            ]
          : []),
        reset(["fallback"]),
      ],
    )
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
    menu("Review policy", "All sessions on this server", () => [
      {
        title: "Default reviewer mode",
        value: value("defaultMode", reviewLabels[values().defaultMode]),
        run: () =>
          choose(
            "Default reviewer mode",
            "All sessions on this server",
            ["manual", "shadow", "auto"] as const,
            (item) => reviewLabels[item],
            (defaultMode) => patch({ defaultMode }),
          ),
      },
      {
        title: "Reviewed actions",
        value: value(
          "actions",
          values().actions === null ? "All actions" : values().actions!.join(", ") || "No actions",
        ),
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
            {
              title: "Use configured actions",
              run: async () => {
                await save({ patch: {}, reset: ["actions"] })
                back()
              },
            },
          ]),
      },
      {
        title: "Additional instructions",
        value: value("policy", values().policy || "None"),
        run: () =>
          edit("Additional policy instructions", values().policy, async (policy) => {
            await patch({ policy })
            back()
          }),
      },
      { title: "Clear additional instructions", run: () => patch({ policy: "" }) },
      reset(["defaultMode", "actions", "policy"]),
    ])
  const sessionMenu = () =>
    menu("This session", session() ? "Current session" : "No session selected; choose a preset to create one", () =>
      session()
        ? [
            {
              title: "Reviewer mode",
              value: `${reviewLabels[session()!.mode]} · ${session()!.modeSource}`,
              run: () =>
                choose(
                  "Reviewer mode",
                  "This session",
                  ["manual", "shadow", "auto"] as const,
                  (mode) => reviewLabels[mode],
                  (mode) => change({ type: "reviewer", mode }),
                ),
            },
            ...(session()!.fallback
              ? [
                  {
                    title: "Second opinion mode",
                    value: `${fallbackLabels[session()!.fallback!.mode]} · ${session()!.fallbackSource}`,
                    run: () =>
                      choose(
                        "Second opinion mode",
                        "This session; children use the server default",
                        ["off", "shadow", "auto"] as const,
                        (mode) => fallbackLabels[mode],
                        (mode) => change({ type: "fallback", mode }),
                      ),
                  },
                ]
              : []),
            {
              title: "Restore inherited scope and reviewer",
              run: () => change({ type: "reset", target: "selection" }),
            },
            { title: "Restore default second-opinion mode", run: () => change({ type: "reset", target: "fallback" }) },
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
                    `${scopeName(session()!)}\nReviewer: ${reviewLabels[session()!.mode]} (${session()!.modeSource})\nModel: ${modelName(session()!.model)}\nInherited from: ${session()!.inheritedFrom ?? "none"}\nSecond opinion: ${session()!.fallback ? fallbackLabels[session()!.fallback!.mode] : "inactive"} (${session()!.fallbackSource})\n\nConfigured approval requirements and denials always apply. Presets can add requirements; Full access adds none. These are tool approval policies, not an OS sandbox.`,
                  ),
              },
            ]
          : [],
    )
  const settingsMenu = () =>
    menu("Permission settings", "Choose a section; each setting shows its scope", () => [
      {
        title: "This session",
        value: session() ? reviewLabels[session()!.mode] : "No session selected",
        run: sessionMenu,
      },
      { title: "Primary reviewer", value: modelName(values().model), run: primary },
      {
        title: "Second opinion",
        value: values().fallback ? fallbackLabels[values().fallback!.mode] : "Not configured",
        run: second,
      },
      { title: "Review policy", value: reviewLabels[values().defaultMode], run: policy },
      { title: "Activity", value: "History, remembered approvals and effective permissions", run: activity },
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
          value: `${matchesPreset(session(), preset) ? "Active · " : ""}${presets[preset].description}`,
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
        { title: "Settings", value: "Session, reviewers, policy and activity", run: settingsMenu },
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
  return (
    <box padding={1} gap={1}>
      <text fg={theme.text.base}>{page()?.title ?? "Permissions"}</text>
      <Show when={page()} keyed>
        {(current) =>
          current.type === "editor" ? (
            <textarea
              keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
              initialValue={current.value}
              height={6}
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
                if (event.eventType === "release") return
                const character =
                  !event.ctrl &&
                  !event.meta &&
                  (event.sequence.length === 1 && event.sequence >= " " ? event.sequence : "")
                if (
                  !character &&
                  !["escape", "up", "down", "return", "pageup", "pagedown", "backspace", "home", "end"].includes(
                    event.name,
                  ) &&
                  !(event.ctrl && event.name === "u")
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                if (busy()) return
                if (event.name === "escape") return back()
                if (event.name === "pageup") return scroll?.scrollBy(-5)
                if (event.name === "pagedown") return scroll?.scrollBy(5)
                if (current.type !== "menu") return
                if (character || event.name === "backspace" || (event.ctrl && event.name === "u")) {
                  setPages((items) => [
                    ...items.slice(0, -1),
                    {
                      ...current,
                      selected: 0,
                      scroll: 0,
                      query: character
                        ? current.query + character
                        : event.name === "backspace"
                          ? current.query.slice(0, -1)
                          : "",
                    },
                  ])
                  return
                }
                if (event.name === "return") {
                  const row = rows()[current.selected]
                  if (row) run(row.run)
                  return
                }
                const next = Math.max(
                  0,
                  Math.min(
                    rows().length - 1,
                    event.name === "home"
                      ? 0
                      : event.name === "end"
                        ? rows().length - 1
                        : current.selected + (event.name === "up" ? -1 : 1),
                  ),
                )
                setPages((items) => [
                  ...items.slice(0, -1),
                  { ...current, selected: next, scroll: Math.max(0, next * 3 - 6) },
                ])
              }}
            >
              <Show when={current.type === "menu"}>
                <text fg={theme.text.muted}>
                  {current.type === "menu"
                    ? typeof current.scope === "function"
                      ? current.scope()
                      : current.scope
                    : ""}
                </text>
                <text fg={theme.text.formfield.base}>
                  {current.type === "menu" && current.query
                    ? `Filter: ${current.query} · Ctrl+U clear`
                    : "Type to filter"}
                </text>
              </Show>
              <scrollbox
                maxHeight={14}
                ref={(item) => {
                  scroll = item
                }}
              >
                <Show when={current.type === "detail"}>
                  <text fg={theme.text.base}>{current.type === "detail" ? current.text : ""}</text>
                </Show>
                <Show when={current.type === "menu"}>
                  <Show when={rows().length} fallback={<text fg={theme.text.muted}>No entries.</text>}>
                    <For each={rows()}>
                      {(row, index) => (
                        <box paddingBottom={1} onMouseDown={() => run(row.run)}>
                          <text
                            fg={
                              current.type === "menu" && index() === current.selected
                                ? theme.text.formfield.selected
                                : theme.text.formfield.base
                            }
                          >
                            {current.type === "menu" && index() === current.selected ? "› " : "  "}
                            {row.title}
                          </text>
                          <Show when={row.value}>
                            <text fg={theme.text.muted}>{row.value}</text>
                          </Show>
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>
              </scrollbox>
            </box>
          )
        }
      </Show>
      <Show when={error()}>
        <text fg={theme.text.feedback.error.base}>{error()}</text>
      </Show>
      <text fg={theme.text.action.primary.base}>
        {busy()
          ? "Loading…"
          : page()?.type === "editor"
            ? "Ctrl+S save · Esc cancel"
            : "↑↓ navigate · Enter open · Esc back · PgUp/PgDn scroll"}
      </text>
    </box>
  )
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
    `Action: ${entry.action}`,
    `Resources: ${entry.resources?.join(", ") ?? "none"}`,
    `Reviewer: ${modelName(entry.model)}`,
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
          `Second opinion: ${modelName(entry.fallback.model)} · ${entry.fallback.mode}`,
          `${entry.fallback.trigger} · ${entry.fallback.status} · ${entry.fallback.durationMs} ms`,
          `${entry.fallback.decision}: ${entry.fallback.reason}`,
          entry.fallback.applied ? "Used in reviewer decision" : "Did not change reviewer decision",
        ]
      : []),
    entry.reason,
    "This records the review, not whether the tool executed or how the user replied.",
    `Request: ${entry.requestID}`,
  ].join("\n")
}
