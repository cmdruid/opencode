import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../../tui/src/theme/assets/v2/opencode2.json"
import { presentation, preparePresentation, takeTerminal } from "../native"

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

test.each([40, 120])("handoff captures fresh successive frames at %s columns", async (width) => {
  await using app = await createTestRenderer({ width, height: 24 })
  const text = new TextRenderable(app.renderer, { id: "background", content: "OLD conversation" })
  app.renderer.root.add(text)
  await app.renderOnce()
  for (const content of ["NEW conversation", "NEXT conversation"]) {
    text.content = content
    const frame = await preparePresentation(app.renderer)
    expect(frame.subarray(40).toString()).toContain(content)
    expect(frame.subarray(40).toString()).not.toContain("OLD conversation")
  }
})

test("handoff waits beyond an in-flight frame", async () => {
  await using app = await createTestRenderer({ width: 80, height: 24 })
  const text = new TextRenderable(app.renderer, { id: "background", content: "OLD conversation" })
  app.renderer.root.add(text)
  await app.renderOnce()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const callback = async () => {
    entered.resolve()
    await release.promise
  }
  app.renderer.setFrameCallback(callback)
  const rendering = app.renderOnce()
  await entered.promise
  const frameID = app.renderer.frameId
  text.content = "NEW conversation"
  const prepared = preparePresentation(app.renderer)
  release.resolve()
  const frame = await prepared
  expect(app.renderer.frameId).toBeGreaterThan(frameID)
  expect(frame.subarray(40).toString()).toContain("NEW conversation")
  await rendering
})

test("aborting a fresh-frame wait removes listeners and never suspends or launches native code", async () => {
  await using app = await createTestRenderer({ width: 80, height: 24 })
  const controller = new AbortController()
  const listeners = app.renderer.listenerCount("frame")
  const result = takeTerminal(app.renderer, "/must-not-be-launched", [], undefined, controller.signal)
  controller.abort(new Error("cancelled before handoff"))
  await expect(result).rejects.toThrow("cancelled before handoff")
  expect(app.renderer.listenerCount("frame")).toBe(listeners)
  expect(app.renderer.controlState).not.toBe("explicit_suspended")
})
