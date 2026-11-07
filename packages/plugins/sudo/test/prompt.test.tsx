import { expect, test } from "bun:test"
import { CodeRenderable, ScrollBoxRenderable, addDefaultParsers } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../../tui/src/theme/assets/v2/opencode2.json"
import parsers from "../../../tui/src/parsers-config"
import { ApprovalPrompt } from "../prompt"

addDefaultParsers(parsers.parsers)

const request = {
  id: "request",
  sessionID: "session",
  reason: "Inspect the privileged service identity.",
  command: "id -u",
  cwd: "/tmp/project",
  host: "test-server",
  user: "owner",
  socket: "/tmp/request.sock",
}

test.each([40, 100])("approval has no password input at %s columns", async (width) => {
  const actions: string[] = []
  await using app = await testRender(
    () => (
      <ApprovalPrompt
        request={request}
        closed={false}
        theme={resolveThemeDocument(parseThemeDocument(themeSource), "dark")}
        onSubmit={() => actions.push("submit")}
        onCancel={() => actions.push("cancel")}
      />
    ),
    { width, height: 24, kittyKeyboard: true },
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("Enter approve · Esc cancel")
  expect(app.captureCharFrame()).not.toContain("Backslashes")
  expect(app.captureCharFrame()).not.toContain("Sudo request for")
  expect(app.captureCharFrame()).not.toContain("PgUp/PgDn")
  expect(app.captureCharFrame().trimEnd().split("\n").length).toBeLessThanOrEqual(width === 40 ? 10 : 8)
  await app.mockInput.pasteBracketedText("arbitrary\ninput")
  await app.mockInput.typeText("arbitrary")
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("arbitrary")
  expect(actions).toEqual([])
  app.mockInput.pressKey("\u001b[13;1:2u")
  expect(actions).toEqual([])
  app.mockInput.pressEnter()
  app.mockInput.pressEscape()
  expect(actions).toEqual(["submit", "cancel"])
})

test.each(["command", "cwd", "host", "reason"] as const)(
  "approval exposes invisible characters in %s",
  async (field) => {
    await using app = await testRender(
      () => (
        <ApprovalPrompt
          request={{ ...request, [field]: "./id\u200b\u009b\u202e\u034f\\u{200b}" }}
          closed={false}
          theme={resolveThemeDocument(parseThemeDocument(themeSource), "light")}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 100, height: 30, kittyKeyboard: true },
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("./id\\u{200b}\\u{9b}\\u{202e}\\u{34f}\\\\u{200b}")
  },
)

test.each([40, 100])("keyboard can review a long command at %s columns", async (width) => {
  await using app = await testRender(
    () => (
      <ApprovalPrompt
        request={{ ...request, command: Array.from({ length: 30 }, (_, i) => `echo line-${i}`).join("\n") }}
        closed={false}
        theme={resolveThemeDocument(parseThemeDocument(themeSource), "dark")}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    ),
    { width, height: 24, kittyKeyboard: true },
  )
  await app.renderOnce()
  await app.waitForFrame((frame) => frame.includes("PgUp/PgDn"))
  app.mockInput.pressKey("\u001b[6~")
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("line-0")
  app.mockInput.pressKey("\u001b[F")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("line-29")
  app.mockInput.pressKey("\u001b[5~")
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("line-29")
  app.mockInput.pressKey("\u001b[H")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("line-0")
})

for (const mode of ["light", "dark", "custom"] as const) {
  test.each([
    [40, 16],
    [100, 30],
  ])(`command inspection preserves text and scrolling in ${mode} at %sx%s`, async (width, height) => {
    const source =
      mode === "custom"
        ? { ...themeSource, base: { ...themeSource.base, syntax: { ...themeSource.base.syntax, string: "#aabbcc" } } }
        : themeSource
    const theme = resolveThemeDocument(parseThemeDocument(source), mode === "light" ? "light" : "dark")
    const command =
      `printf '%s | > $(literal)' "$VALUE"
${"echo long-argument-" + "x".repeat(200)}
` + Array.from({ length: 30 }, (_, i) => `echo row-${i}`).join("\n")
    const input = { ...request, command, reason: "Review " + "long reason ".repeat(35) }
    const submitted: string[] = []
    await using app = await testRender(
      () => (
        <ApprovalPrompt
          request={input}
          theme={theme}
          closed={false}
          onSubmit={() => submitted.push(input.command)}
          onCancel={() => {}}
        />
      ),
      { width, height, kittyKeyboard: true },
    )
    await app.renderOnce()
    const code = app.renderer.root.findDescendantById("sudo-command")
    const scroll = app.renderer.root.findDescendantById("sudo-review")
    if (!(code instanceof CodeRenderable) || !(scroll instanceof ScrollBoxRenderable))
      throw new Error("Missing review content")
    await code.highlightingDone
    await app.renderOnce()
    expect(code.content).toBe(command)
    expect(code.syntaxStyle.getStyle("string")?.fg?.toInts()).toEqual(theme.surface("dialog").syntax.string.toInts())
    expect(app.captureCharFrame()).toContain("Enter approve")
    app.mockInput.pressKey("\u001b[6~")
    await app.renderOnce()
    const position = scroll.scrollTop
    expect(position).toBeGreaterThan(0)
    app.mockInput.pressKey("\t")
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(position)
    expect(app.captureCharFrame()).toContain("collapse")
    app.mockInput.pressKey("\t")
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(position)
    await app.mockInput.pasteBracketedText("\n\tpassword")
    expect(submitted).toEqual([])
    app.mockInput.pressKey("\u001b[F")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("row-29")
    app.mockInput.pressEnter()
    expect(submitted).toEqual([command])
  })
}

test("highlighting follows original quotes while display escapes remain visible", async () => {
  const theme = resolveThemeDocument(parseThemeDocument(themeSource), "dark")
  const command = 'printf "a\\"b | >" "café 🐈"'
  await using app = await testRender(
    () => (
      <ApprovalPrompt
        request={{ ...request, command }}
        theme={theme}
        closed={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    ),
    { width: 100, height: 24, kittyKeyboard: true },
  )
  await app.renderOnce()
  const code = app.renderer.root.findDescendantById("sudo-command")
  if (!(code instanceof CodeRenderable)) throw new Error("Missing command")
  await code.highlightingDone
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain('a\\\\"b | >')
  const literal = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("b | >"))
  expect(literal?.fg.toInts()).toEqual(theme.surface("dialog").syntax.string.toInts())
})
