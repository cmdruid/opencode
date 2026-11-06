import type { Renderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"

/** Navigate rendered menu rows through the same arrow/Enter controls as the user. */
export async function selectPermissionRow(
  setup: Pick<TestRendererSetup, "renderer" | "mockInput" | "renderOnce">,
  title: string,
) {
  const rows = (item: Renderable): Renderable[] =>
    item.id.startsWith("permission-row:") ? [item] : item.getChildren().flatMap(rows)
  const entries = rows(setup.renderer.root)
  const exact = entries.findIndex((item) => item.id === `permission-row:${title}`)
  const index = exact >= 0 ? exact : entries.findIndex((item) => item.id.includes(title))
  if (index < 0) throw new Error(`Missing menu row: ${title}; available: ${entries.map((item) => item.id).join(", ")}`)
  setup.mockInput.pressKey("HOME")
  await setup.renderOnce()
  for (let i = 0; i < index; i++) {
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
  }
  return rows(setup.renderer.root)[index]
}
