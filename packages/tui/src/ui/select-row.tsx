import { RGBA, TextAttributes } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { createMemo, Show, type JSX } from "solid-js"

/** The same compact row used by native dialogs and bundled plugin settings. */
export function SelectRow(props: {
  title: string
  titleView?: JSX.Element
  description?: string
  active: boolean
  current: boolean
  footer?: JSX.Element | string
  footerColor?: RGBA
  footerOverhang?: number
  titleWidth?: number
  truncateTitle?: boolean | "left"
  gutter?: (color: RGBA) => JSX.Element
  margin?: JSX.Element
  activeBackground?: RGBA
  activeColor?: RGBA
  theme: ResolvedTheme
  newDesigns?: boolean
  inset: number
}) {
  const theme = props.theme
  const newDesigns = () => props.newDesigns === true
  const title = createMemo(() => {
    const width = props.titleWidth ?? 61
    if (props.truncateTitle === false || props.title.length <= width) return props.title
    return props.truncateTitle === "left"
      ? "…" + props.title.slice(-(width - 1))
      : props.title.slice(0, width - 1) + "…"
  })
  const text = createMemo(() => {
    if (props.active) return props.activeColor ?? theme.text.action.primary.focused
    if (props.current && !newDesigns()) return theme.text.formfield.selected
    return theme.text.base
  })
  // Secondary text (description and footer).
  const secondary = () => {
    if (!newDesigns()) return props.active ? text() : theme.text.muted
    return props.active ? theme.text.action.secondary.focused : theme.text.muted
  }

  const row = () => (
    // A marker or gutter takes its cell plus the row gap out of the left padding,
    // so titles line up with unmarked rows: scroll pad (1) + marker (1) + gap (1).
    <box
      flexDirection="row"
      flexGrow={newDesigns() ? 1 : undefined}
      paddingLeft={props.current || props.gutter ? props.inset - 3 : props.inset - 1}
      paddingRight={props.inset - (newDesigns() ? 0 : 1)}
      gap={1}
      backgroundColor={
        props.active ? (props.activeBackground ?? theme.background.action.primary.focused) : RGBA.fromInts(0, 0, 0, 0)
      }
    >
      <Show when={!props.current && props.margin}>
        <box position="absolute" left={props.inset - 3} flexShrink={0}>
          {props.margin}
        </box>
      </Show>
      <Show when={props.current && !props.gutter}>
        <text flexShrink={0} fg={newDesigns() ? theme.text.formfield.selected : text()}>
          {newDesigns() ? "▪" : "●"}
        </text>
      </Show>
      <Show when={props.gutter}>
        <box flexShrink={0}>{props.gutter?.(text())}</box>
      </Show>
      <text
        flexGrow={1}
        fg={text()}
        attributes={props.active && !newDesigns() ? TextAttributes.BOLD : undefined}
        overflow="hidden"
        wrapMode="none"
        paddingLeft={3}
      >
        {props.titleView ?? title()}
        <Show when={props.description}>
          <span style={{ fg: secondary() }}>{" " + props.description}</span>
        </Show>
      </text>
      <Show when={props.footer}>
        <box flexShrink={0} marginRight={props.footerOverhang ? -props.footerOverhang : undefined}>
          <text fg={props.active || !props.footerColor ? secondary() : props.footerColor}>{props.footer}</text>
        </box>
      </Show>
    </box>
  )

  return (
    <Show when={newDesigns()} fallback={row()}>
      <box flexDirection="row">
        <text width={1} flexShrink={0} fg={theme.text.formfield.focused}>
          {props.active ? "┃" : " "}
        </text>
        {row()}
      </box>
    </Show>
  )
}
