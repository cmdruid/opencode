import type { Plugin } from "@opencode/plugin/tui"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { SyntaxStyle, getTreeSitterClient } from "@opentui/core"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
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
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [lines, setLines] = createSignal(1)
  const [position, setPosition] = createSignal(0)
  const [expanded, setExpanded] = createSignal(false)
  const height = () => Math.min(lines(), Math.max(2, dimensions().height - 10), expanded() ? Infinity : 8)
  const theme = props.theme.surface("dialog")
  const syntax = SyntaxStyle.fromStyles(
    {
      default: { fg: theme.text.base },
      ...Object.fromEntries(Object.entries(theme.syntax).map(([name, fg]) => [name, { fg }])),
    },
    renderer.nativeScene,
  )
  onCleanup(() => syntax.destroy())
  const frame = () => {
    if (!scroll) return
    setLines(scroll.scrollHeight)
    setPosition(scroll.scrollTop)
  }
  renderer.on("frame", frame)
  onCleanup(() => renderer.off("frame", frame))
  onMount(() => target?.focus())

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box>
        <text fg={theme.text.base}>sudo · {display(props.request.host)}</text>
        <text fg={theme.text.muted}>{display(props.request.cwd)}</text>
      </box>
      <scrollbox
        id="sudo-review"
        ref={(value) => {
          scroll = value
          value.content.on("resize", () => setLines(value.scrollHeight))
        }}
        height={height()}
        scrollbarOptions={{ visible: false }}
        minHeight={1}
      >
        <box gap={1}>
          <text fg={theme.text.base}>{display(props.request.reason)}</text>
          <line_number fg={theme.text.muted} showLineNumbers={true} minWidth={1} paddingRight={1}>
            <code
              id="sudo-command"
              content={display(props.request.command, true)}
              filetype="bash"
              onHighlight={async (highlights, context) => {
                if (context.content === props.request.command) return highlights
                // Display escapes must not change how quotes and operators are colored.
                const parsed = await getTreeSitterClient().highlightOnce(props.request.command, "bash")
                const offsets = new Map([[0, 0]])
                Array.from(props.request.command).reduce((position, character) => {
                  offsets.set(position + character.length, offsets.get(position)! + display(character, true).length)
                  return position + character.length
                }, 0)
                return (parsed.highlights ?? []).map(([start, end, group, meta]) => [
                  offsets.get(start)!,
                  offsets.get(end)!,
                  group,
                  meta,
                ])
              }}
              syntaxStyle={syntax}
              conceal={false}
              wrapMode="char"
              fg={theme.text.base}
            />
          </line_number>
        </box>
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
          if (event.name === "tab" && !event.repeated && event.eventType !== "repeat") {
            setExpanded((value) => !value)
            return
          }
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
          {props.closed
            ? "Request closed · Esc dismiss"
            : `Enter approve · Esc cancel · Tab ${expanded() ? "collapse" : "expand"}`}
        </text>
      </box>
      <Show when={lines() > height()}>
        <text fg={theme.text.muted}>
          {position() + 1}–{Math.min(lines(), position() + height())}/{lines()} · PgUp/PgDn · Home/End
        </text>
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
