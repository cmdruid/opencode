import type { Plugin } from "@opencode/plugin/tui"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { Show, createSignal, onMount } from "solid-js"
import type { Request } from "./rpc"

export function ApprovalPrompt(props: {
  request: Request
  theme: Plugin.Context["theme"]
  closed: boolean
  error?: string
  onSubmit: () => void
  onCancel: () => void
}) {
  let target: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const [lines, setLines] = createSignal(1)
  const theme = props.theme.surface("dialog")
  onMount(() => target?.focus())

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box>
        <text fg={theme.text.base}>Run as root on {display(props.request.host)}</text>
        <text fg={theme.text.muted}>{display(props.request.cwd)}</text>
      </box>
      <scrollbox
        ref={(value) => {
          scroll = value
          value.content.on("resize", () => setLines(value.scrollHeight))
        }}
        height={Math.min(6, lines())}
        minHeight={1}
      >
        <text fg={theme.text.base}>{display(props.request.command, true)}</text>
      </scrollbox>
      <box
        ref={(value) => {
          target = value
        }}
        minHeight={1}
        focusable
        onKeyDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (event.eventType === "release") return
          if (event.name === "escape" || (event.ctrl && event.name === "c")) {
            props.onCancel()
            return
          }
          if (props.closed) return
          if (event.name === "pageup") return scroll?.scrollBy(-scroll.height)
          if (event.name === "pagedown") return scroll?.scrollBy(scroll.height)
          if (event.name === "home") return scroll?.scrollTo(0)
          if (event.name === "end") return scroll?.scrollTo(Infinity)
          if (event.name === "return" && !event.repeated && event.eventType !== "repeat") props.onSubmit()
        }}
        onPaste={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <text fg={theme.text.action.primary.base} selectable={false}>
          {props.closed ? "Request closed · Esc dismiss" : "Enter approve · Esc cancel"}
        </text>
      </box>
      <Show when={lines() > 6}>
        <text fg={theme.text.muted}>PgUp/PgDn · Home/End</text>
      </Show>
      <Show when={props.error}>
        <text fg={theme.text.feedback.error.base}>{props.error}</text>
      </Show>
    </box>
  )
}

// Escaping backslashes too distinguishes a literal escape from a hidden character in an executable/path.
function display(value: string, multiline = false) {
  return value.replace(/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, (character) => {
    if (character === "\n" && multiline) return character
    if (character === "\\") return "\\\\"
    return `\\u{${character.codePointAt(0)!.toString(16)}}`
  })
}
