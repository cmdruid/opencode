import type { Plugin } from "@opencode/plugin/tui"
import { Schema } from "effect"
import { createSignal, Show } from "solid-js"
import { PermissionSettings } from "../../../../../plugins/permission-review/settings-ui"
import { settingsFixture } from "../../../../../plugins/permission-review/settings.fixture"
import { State } from "../../../../../plugins/permission-review/contract"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

function PermissionSettingsStory(props: { context: Plugin.Context }) {
  const [data, setData] = createSignal(settingsFixture())
  const [revision, setRevision] = createSignal(0)
  const refresh = () => setRevision((value) => value + 1)
  const status = () => {
    revision()
    return data().fixture.failure ? "Save failure enabled" : "Local fixture; no server writes"
  }
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        bind: "f2",
        title: "Toggle session",
        run() {
          data().fixture.session = data().fixture.session
            ? undefined
            : Schema.decodeUnknownSync(State)({
                preset: "workspace",
                mode: "shadow",
                model: { providerID: "fixture", id: "classifier" },
                modeSource: "session",
                fallbackSource: "configuration",
                fallback: { model: { providerID: "fixture", id: "chat" }, mode: "shadow", timeoutMs: 10000 },
              })
          refresh()
        },
      },
      {
        bind: "f3",
        title: "Toggle server override",
        run() {
          data().fixture.overrides = data().fixture.overrides.policy
            ? {}
            : {
                policy:
                  "A long server policy: only perform effects authorized by the current task; ask when the target is unclear.",
                defaultMode: "manual",
              }
          refresh()
        },
      },
      {
        bind: "f4",
        title: "Toggle inheritance",
        run() {
          const current = data().fixture.session
          if (current)
            data().fixture.session = Schema.decodeUnknownSync(State)({
              ...current,
              modeSource: current.inheritedFrom ? "session" : "ancestor",
              inheritedFrom: current.inheritedFrom ? undefined : "ses_fixture_parent",
            })
          refresh()
        },
      },
      {
        bind: "f5",
        title: "Toggle save failure",
        run() {
          data().fixture.failure = data().fixture.failure ? "" : "Fixture: save failed. Your draft is preserved."
          refresh()
        },
      },
      {
        bind: "f6",
        title: "Reset fixture",
        run() {
          setData(settingsFixture())
          refresh()
        },
      },
    ],
  }))
  return (
    <box height="100%" flexDirection="column">
      <box flexGrow={1}>
        <Show when={data()} keyed>
          {(fixture) => (
            <PermissionSettings
              theme={props.context.theme}
              actions={fixture.actions}
              revision={revision()}
              onClose={() => props.context.ui.router.navigate({ type: "plugin", name: "storybook" })}
            />
          )}
        </Show>
      </box>
      <StoryFooter
        context={props.context}
        title="Permission settings"
        status={status()}
        controls={[
          { shortcut: "F2", label: "session" },
          { shortcut: "F3", label: "server values" },
          { shortcut: "F4", label: "inheritance" },
          { shortcut: "F5", label: "save error" },
          { shortcut: "F6", label: "reset" },
          { shortcut: "Esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const permissionSettingsStory: Story = {
  id: "permission-settings",
  title: "Permission settings",
  render: (context) => <PermissionSettingsStory context={context} />,
}
