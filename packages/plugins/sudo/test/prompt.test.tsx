import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../../tui/src/theme/assets/v2/opencode2.json"
import { ApprovalPrompt } from "../prompt"

const request = {
  id: "request",
  sessionID: "session",
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
  expect(app.captureCharFrame().trimEnd().split("\n").length).toBeLessThanOrEqual(7)
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

test.each(["command", "cwd", "host"] as const)("approval exposes invisible characters in %s", async (field) => {
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
})

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
