import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../../tui/src/theme/assets/v2/opencode2.json"
import { presentation } from "../native"

test.each(["light", "dark", "custom"] as const)(
  "native presentation uses %s dialog tokens and safe pre-authentication text",
  async (mode) => {
    await using app = await createTestRenderer({ width: 80, height: 24 })
    app.renderer.root.add(
      new TextRenderable(app.renderer, { id: "background", content: "OpenCode conversation\nUnicode café" }),
    )
    await app.renderOnce()
    const source =
      mode === "custom"
        ? {
            ...themeSource,
            base: { ...themeSource.base, text: { ...themeSource.base.text, base: "#aabbcc" } },
          }
        : themeSource
    const theme = resolveThemeDocument(parseThemeDocument(source), mode === "custom" ? "dark" : mode)
    const frame = presentation(app.renderer, theme)
    expect(frame.subarray(0, 8).toString()).toBe("OCUI1\0\0\0")
    expect(frame.readUInt32BE(8)).toBe(80)
    expect(frame.readUInt32BE(12)).toBe(24)
    expect(frame.readUInt32BE(36)).toBe(frame.length - 40)
    const rgb = theme.surface("dialog").text.base.toInts()
    expect(frame.readUInt32BE(16)).toBe(process.env.NO_COLOR ? 0xffffffff : (rgb[0] << 16) | (rgb[1] << 8) | rgb[2])
    expect(frame.subarray(40).toString()).toContain("OpenCode conversation")
    expect(frame.subarray(40).toString()).toMatch(/^[\x20-\x7e\n]*$/)
  },
)

test("native presentation falls back to monochrome branding without a frame lease", async () => {
  await using app = await createTestRenderer({ width: 40, height: 16 })
  await app.renderer.setupTerminal()
  await app.renderer.suspend()
  const frame = presentation(app.renderer)
  expect(frame.length).toBe(40)
  expect(frame.readUInt32BE(16)).toBe(0xffffffff)
  await app.renderer.resume()
})
