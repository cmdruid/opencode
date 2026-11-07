import { createSignal } from "solid-js"
import { Schema } from "effect"
import { Assessment, SessionApproval } from "./contract"
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { parseThemeDocument, resolveThemeDocument } from "@opencode/theme/tui"
import themeSource from "../../tui/src/theme/assets/v2/opencode2.json"
import { describe, PermissionSettings } from "./settings-ui"
import { selectPermissionRow } from "./navigation.fixture"
import { settingsFixture } from "./settings.fixture"

async function fixture(width = 112) {
  const data = settingsFixture()
  const closed = { value: false }
  const [revision, setRevision] = createSignal(0)
  const app = await testRender(
    () => (
      <PermissionSettings
        theme={resolveThemeDocument(parseThemeDocument(themeSource), "dark")}
        actions={data.actions}
        revision={revision()}
        onClose={() => {
          closed.value = true
        }}
      />
    ),
    { width, height: 36, kittyKeyboard: true },
  )
  const ready = async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
      await app.renderOnce()
      if (!app.captureCharFrame().includes("Loading…")) return
    }
    throw new Error(app.captureCharFrame())
  }
  await ready()
  const open = async (name: string) => {
    await selectPermissionRow(app, name)
    app.mockInput.pressEnter()
    await ready()
  }
  const back = async () => {
    app.mockInput.pressEscape()
    await ready()
  }
  const submit = async () => {
    app.mockInput.pressKey("s", { ctrl: true })
    await ready()
  }
  return {
    app,
    data,
    closed,
    ready,
    refresh: async () => {
      setRevision((value) => value + 1)
      await ready()
    },
    open,
    back,
    submit,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
    },
  }
}

test.each([44, 112])(
  "new-session menu marks Ask for approval and offers Approve for me at %s columns",
  async (width) => {
    await using f = await fixture(width)
    const selected = () =>
      f.app
        .captureCharFrame()
        .split("\n")
        .find((line) => /[●▪]/.test(line))
    expect(selected()).toContain("Ask for approval")
    expect(f.app.captureCharFrame()).toContain("Approve for me")
    expect(f.data.fixture.session).toBeUndefined()
    await f.data.actions.change({ type: "preset", preset: "workspace" })
    await f.refresh()
    expect(selected()).toContain("Ask for approval")
    await f.open("Approve for me")
    expect(f.data.fixture.session).toMatchObject({ preset: "auto", mode: "auto" })
  },
)

test.each([44, 112])(
  "settings overview and long values fit at %s columns without creating a session",
  async (width) => {
    await using f = await fixture(width)
    await f.open("Settings")
    expect(f.app.captureCharFrame()).toContain("Permission settings")
    expect(f.app.captureCharFrame()).toContain("Classifier")
    const lines = f.app.captureCharFrame().split("\n")
    const classifier = lines.findIndex((line) => line.includes("Classifier"))
    expect(lines[classifier + 1]).toContain("Reviewer")
    expect(lines[classifier + 2]).toContain("Session Policy")
    expect(lines[classifier + 3]).toContain("Global Policy")
    expect(lines[classifier + 4]).toContain("Review Rules")
    expect(lines[classifier + 5]).toContain("Activity")
    expect(lines[classifier + 7]).toContain("Fast decision model")
    expect(f.data.fixture.session).toBeUndefined()
    expect(f.app.captureCharFrame()).not.toContain("Type to filter")
    await f.app.mockInput.typeText("junk")
    await f.ready()
    expect(f.app.captureCharFrame()).not.toContain("Filter:")
    expect(f.app.captureCharFrame()).toContain("Classifier")
    await f.open("Classifier")
    expect(f.app.captureCharFrame()).toContain("configuration")
    expect(f.app.captureCharFrame()).toContain("fixture/classifier")
    await f.back()
    expect(f.app.captureCharFrame()).toContain("Permission settings")
    await f.back()
    expect(f.closed.value).toBe(false)
    await f.back()
    expect(f.closed.value).toBe(true)
  },
)

test("editor preserves a failed draft, saves to its parent, and cancels without writes", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Review Rules")
  await f.open("Additional instructions")
  await f.app.mockInput.typeText("Only the requested effects")
  f.data.fixture.failure = "Fixture save failed"
  await f.submit()
  expect(f.app.captureCharFrame()).toContain("Fixture save failed")
  expect(f.app.captureCharFrame()).toContain("Only the requested effects")
  expect(f.data.fixture.writes).toEqual([])
  f.data.fixture.failure = ""
  await f.submit()
  expect(f.app.captureCharFrame()).toContain("Review Rules")
  expect(f.data.fixture.writes).toEqual([{ patch: { policy: "Only the requested effects" } }])
  await f.open("Additional instructions")
  await f.app.mockInput.typeText("Discard me")
  await f.back()
  expect(f.data.fixture.writes).toHaveLength(1)
  f.app.mockInput.pressKey("r", { ctrl: true })
  await f.ready()
  await f.open("Reset to Defaults")
  expect(f.data.fixture.writes[1]).toEqual({
    patch: {},
    reset: ["autoAllowTools", "workspaceReads", "actions", "policy"],
  })
})

test("classifier selection only offers decision models; reviewer selection offers chat and variants", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Classifier")
  expect(f.app.captureCharFrame()).not.toContain("Backend")
  await f.open("Model")
  expect(f.app.captureCharFrame()).not.toContain("chat")
  await f.open("classifier")
  expect(f.app.captureCharFrame()).toContain("Classifier")
  expect(f.data.fixture.writes[0]).toMatchObject({
    patch: { mode: "decision", model: { providerID: "fixture", id: "classifier" } },
  })
  await f.back()
  await f.open("Reviewer")
  await f.open("Model")
  expect(f.app.captureCharFrame()).not.toContain("classifier")
  await f.open("chat")
  await f.open("bounded")
  expect(f.app.captureCharFrame()).toContain("Reviewer")
  expect(f.data.fixture.writes[1]).toMatchObject({ patch: { fallback: { model: { id: "chat", variant: "bounded" } } } })
})

test("connection is a single draft; changing an endpoint cannot keep its saved key", async () => {
  await using f = await fixture()
  f.data.fixture.connection.custom = true
  f.data.fixture.connection.authenticated = true
  await f.open("Settings")
  await f.open("Classifier")
  await f.open("Connection")
  await f.open("Base URL")
  await f.app.mockInput.typeText("/new")
  await f.submit()
  expect(f.data.fixture.writes).toEqual([])
  await f.open("Save connection")
  expect(f.app.captureCharFrame()).toContain("Endpoint changed")
  await f.open("Authentication")
  await f.open("No API key")
  await f.open("Save connection")
  expect(f.data.fixture.writes[0]).toMatchObject({ patch: {}, connection: { role: "classifier", apiKey: "" } })
  await f.open("Connection")
  await f.open("Authentication")
  await f.open("Set API key")
  await f.open("API key")
  await f.app.mockInput.typeText("discarded-secret")
  await f.submit()
  await f.open("Cancel")
  expect(f.data.fixture.writes).toHaveLength(1)
})

test("numeric and policy controls bind to their server fields, including all versus no actions", async () => {
  await using f = await fixture()
  await f.open("Settings")
  await f.open("Classifier")
  await f.open("Minimum approval score")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("101")
  await f.submit()
  expect(f.data.fixture.writes).toHaveLength(0)
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("90%")
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.minConfidence).toBe(0.9)
  expect(f.app.captureCharFrame()).toContain("90%")
  await f.open("Minimum approval score")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("85")
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.minConfidence).toBe(0.85)
  expect(f.app.captureCharFrame()).toContain("85%")
  await f.back()
  await f.open("Reviewer")
  await f.open("Timeout (ms)")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.app.mockInput.typeText("500")
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.fallback).toMatchObject({ timeoutMs: 500 })
  await f.open("Remove reviewer")
  expect(f.data.fixture.writes.at(-1)?.patch.fallback).toBeNull()
  await f.back()
  await f.open("Global Policy")
  await f.open("Reviewer Mode")
  await f.open("Approve")
  expect(f.data.fixture.writes.at(-1)?.patch.reviewerMode).toBe("auto")
  await f.open("Classifier Mode")
  await f.open("Manual")
  expect(f.data.fixture.writes.at(-1)?.patch.defaultMode).toBe("manual")
  await f.back()
  await f.open("Review Rules")
  await f.open("Reviewed actions")
  await f.open("Choose action names")
  f.app.mockInput.pressKey("a", { ctrl: true })
  f.app.mockInput.pressKey("k", { ctrl: true })
  await f.submit()
  expect(f.data.fixture.writes.at(-1)?.patch.actions).toEqual([])
  await f.open("Reviewed actions")
  await f.open("All actions")
  expect(f.data.fixture.writes.at(-1)?.patch.actions).toBeNull()
  await f.open("Reviewed actions")
  await f.open("Common actions")
  await f.open("read")
  await f.open("Save actions")
  expect(f.data.fixture.writes.at(-1)?.patch.actions).not.toContain("read")
})

test("activity details return to their lists and revocation updates the local list", async () => {
  await using f = await fixture()
  await f.data.actions.change({ type: "preset", preset: "workspace" })
  f.data.fixture.history.push(
    Schema.decodeUnknownSync(Assessment)({
      requestID: "per_fixture",
      sessionID: "ses_fixture",
      action: "shell",
      resources: ["git status"],
      model: { providerID: "fixture", id: "chat" },
      mode: "chat",
      shadow: true,
      at: 1,
      durationMs: 3,
      decision: "approve",
      reason: "Read-only inspection of the requested project.",
    }),
  )
  f.data.fixture.approvals.push(
    Schema.decodeUnknownSync(SessionApproval)({
      requestID: "per_fixture",
      sessionID: "ses_fixture",
      action: "shell",
      resources: ["git status"],
      directory: "/fixture",
      toolCalls: [],
      at: 1,
    }),
  )
  await f.refresh()
  expect(f.app.captureCharFrame()).not.toContain("new session")
  await f.open("Settings")
  await f.open("Activity")
  await f.open("Review history")
  await f.open("approve")
  expect(f.app.captureCharFrame()).toContain("Shadow proposal")
  expect(f.app.captureCharFrame()).toContain("not whether the tool executed")
  await f.back()
  expect(f.app.captureCharFrame()).toContain("Review history")
  await f.back()
  await f.open("Remembered approvals")
  await f.open("shell")
  await f.open("Details")
  expect(f.app.captureCharFrame()).toContain("git status")
  await f.back()
  expect(f.app.captureCharFrame()).toContain("Remembered approvals")
  await f.open("shell")
  await f.open("Revoke approval")
  expect(f.app.captureCharFrame()).toContain("No entries.")
  expect(f.data.fixture.approvals).toEqual([])
})

test("mouse opens rows; long model lists scroll and return through providers", async () => {
  await using f = await fixture(44)
  const lines = f.app.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes("Settings"))
  await f.app.mockMouse.click(lines[row]!.indexOf("Settings") + 1, row)
  await f.ready()
  expect(f.app.captureCharFrame()).toContain("Permission settings")
  f.data.actions.models = async () => [
    { providerID: "other", id: "other", type: "decision", variants: [] },
    ...Array.from({ length: 20 }, (_, index) => ({
      providerID: "fixture",
      id: `classifier-${index}`,
      type: "decision",
      variants: [],
    })),
  ]
  await f.open("Classifier")
  await f.open("Provider")
  await f.open("fixture")
  f.app.mockInput.pressKey("END")
  await f.ready()
  expect(f.app.captureCharFrame()).toContain("classifier-19")
  f.app.mockInput.pressEnter()
  await f.ready()
  expect(f.app.captureCharFrame()).toContain("Minimum approval score")
  expect(f.data.fixture.writes.at(-1)?.patch).toMatchObject({ mode: "decision", model: { id: "classifier-19" } })
})

test.each([44, 112])(
  "reset hotkey confirms its scope, cancels safely, and leaves other sections intact at %s columns",
  async (width) => {
    await using f = await fixture(width)
    f.data.fixture.overrides = { minConfidence: 0.8, policy: "Keep this policy" }
    await f.refresh()
    await f.open("Settings")
    expect(f.app.captureCharFrame()).toContain("ctrl+r Reset to Defaults")
    await f.open("Classifier")
    expect(f.app.captureCharFrame()).not.toContain("Use configured")
    f.app.mockInput.pressKey("r", { ctrl: true })
    await f.ready()
    expect(f.app.captureCharFrame()).toContain("Reset to Defaults?")
    expect(f.app.captureCharFrame()).toContain("configuration")
    await f.back()
    expect(f.data.fixture.writes).toEqual([])
    f.app.mockInput.pressKey("r", { ctrl: true })
    await f.ready()
    await f.open("Reset to Defaults")
    expect(f.data.snapshot().values.minConfidence).toBe(0.9)
    expect(f.data.snapshot().values.policy).toBe("Keep this policy")
    expect(f.app.captureCharFrame()).toContain("Minimum approval score")
    await f.back()
    f.app.mockInput.pressKey("r", { ctrl: true })
    await f.ready()
    await f.open("Review Rules")
    await f.open("Reset to Defaults")
    expect(f.data.snapshot().values.policy).toBe("")
  },
)

test("Model stays within the selected provider; cancelling a Provider change writes nothing", async () => {
  await using f = await fixture()
  f.data.actions.models = async () => [
    { providerID: "fixture", id: "classifier", type: "decision", variants: [] },
    { providerID: "other", id: "other-classifier", type: "decision", variants: [] },
    { providerID: "fixture", id: "chat", type: "chat", variants: [] },
    { providerID: "other", id: "other-chat", type: "chat", variants: [] },
  ]
  await f.open("Settings")
  for (const section of ["Classifier", "Reviewer"]) {
    await f.open(section)
    await f.open("Model")
    expect(f.app.captureCharFrame()).toContain("Choose model")
    expect(f.app.captureCharFrame()).not.toContain("other-")
    await f.back()
    await f.open("Provider")
    await f.open("other")
    expect(f.app.captureCharFrame()).toContain("other-")
    await f.back()
    await f.back()
    expect(f.data.fixture.writes).toEqual([])
    await f.back()
  }
  await f.open("Global Policy")
  await f.open("Automation Mode")
  await f.open("Reviewer")
  expect(f.data.snapshot().values.reviewWith).toBe("reviewer")
})

test.each([44, 112])("session and global policies have the same three controls at %s columns", async (width) => {
  await using f = await fixture(width)
  await f.data.actions.change({ type: "preset", preset: "auto" })
  await f.refresh()
  await f.open("Settings")
  for (const title of ["Global Policy", "Session Policy"]) {
    await f.open(title)
    const frame = f.app.captureCharFrame()
    expect(frame).toContain("Automation Mode")
    expect(frame).toContain("Both")
    expect(frame).toContain("Classifier Mode")
    expect(frame).toContain("Reviewer Mode")
    expect(frame).not.toContain("Reviewed actions")
    expect(frame).not.toContain("Default automation")
    await f.open("Classifier Mode")
    expect(f.app.captureCharFrame()).toContain("Approve")
    expect(f.app.captureCharFrame()).not.toContain("Approve for me")
    await f.back()
    await f.back()
  }
  await f.open("Session Policy")
  await f.open("Automation Mode")
  await f.open("Reviewer")
  expect(f.data.fixture.session?.reviewWith).toBe("reviewer")
  expect(f.data.snapshot().values.reviewWith).toBe("both")
  await f.open("Reviewer Mode")
  await f.open("Approve")
  expect(f.data.fixture.session?.reviewerMode).toBe("auto")
  expect(f.data.snapshot().values.reviewerMode).toBe("shadow")
  f.app.mockInput.pressKey("r", { ctrl: true })
  await f.ready()
  await f.open("Reset to Defaults")
  expect(f.data.fixture.session?.reviewWith).toBe("both")
})

test("history distinguishes approval scores from confidence and retains legacy threshold meaning", () => {
  const entry = Schema.decodeUnknownSync(Assessment)({
    requestID: "per_score",
    sessionID: "ses_score",
    action: "webfetch",
    model: { providerID: "fixture", id: "decision" },
    mode: "decision",
    shadow: false,
    at: 1,
    durationMs: 3,
    decision: "approve",
    reason: "Authorized public fetch",
    classifier: {
      choice: "approve",
      confidence: 0.8863,
      threshold: 0.9,
      probabilities: [{ value: "approve", probability: 0.9242 }],
      approvalScore: 0.9242,
      thresholdMetric: "approval-score",
    },
  })
  expect(describe(entry)).toContain("Approval score: 92.42%; minimum: 90%")
  expect(describe(entry)).toContain("Provider confidence: 88.63%")
  expect(describe(entry)).toContain("Choice scores: approve 92.42%")
  expect(
    describe({ ...entry, classifier: { ...entry.classifier!, thresholdMetric: undefined, approvalScore: undefined } }),
  ).toContain("Confidence: 88.63%; threshold: 90%")
})

test.each([44, 112])("fast-rule settings persist and reset at %s columns", async (width) => {
  await using f = await fixture(width)
  await f.open("Settings")
  await f.open("Review Rules")
  await f.open("Auto-allow skill")
  expect(f.data.fixture.writes.at(-1)).toEqual({ patch: { autoAllowTools: ["todowrite"] } })
  await f.open("Workspace reads")
  expect(f.data.fixture.writes.at(-1)).toEqual({ patch: { workspaceReads: false } })
  f.app.mockInput.pressKey("r", { ctrl: true })
  await f.ready()
  await f.open("Reset to Defaults")
  expect(f.data.fixture.writes.at(-1)?.reset).toContain("workspaceReads")
  expect(f.data.fixture.writes.at(-1)?.reset).toContain("autoAllowTools")
})
