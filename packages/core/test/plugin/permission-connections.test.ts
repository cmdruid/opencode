import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Document, Info } from "@opencode/schema/config"
import { Credential } from "@opencode/core/credential"
import { Generate } from "@opencode/core/generate"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import reviewer from "../../../plugins/permission-review/index"
import { Contract } from "../../../plugins/permission-review/contract"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/schema/provider"
import { Effect, Exit, Schema } from "effect"
import { connections } from "../../../plugins/permission-review/connections"
import { testEffect } from "../lib/effect"
import { addUserTask, makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer(null, null))
const options = {
  model: Model.Ref.parse("review-source/decision"),
  mode: "decision" as const,
  fallback: { model: Model.Ref.parse("review-source/chat#bounded"), mode: "auto" as const },
}
const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const host = yield* PluginHost.make(plugins, "opencode.permission-review")
  const providerID = Provider.ID.make("review-source")
  yield* host.provider.transform((editor) =>
    editor.add({
      info: {
        id: providerID,
        name: "Source",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://configured.invalid/v1", apiKey: "source-provider-key" },
      },
      models: [
        {
          ...Model.Info.default(providerID, Model.ID.make("decision")),
          type: "decision",
          package: "@opencode/ai/providers/typesafe-ai/decisions",
          settings: { apiKey: "source-model-key" },
          headers: { authorization: "Bearer source-header" },
        },
        {
          ...Model.Info.default(providerID, Model.ID.make("chat")),
          variants: [
            {
              id: Model.VariantID.make("bounded"),
              body: { reasoning_effort: "low", max_tokens: 1024 },
              settings: { apiKey: "source-variant-key" },
              headers: { "x-api-key": "source-variant-header" },
            },
          ],
        },
      ],
    }),
  )
  const connection = yield* connections(host, options)
  return { host, connection }
})

it.live("reviewer connections persist separately, isolate credentials, and restore configured providers", () =>
  Effect.gen(function* () {
    const test = yield* setup
    const credentials = yield* Credential.Service
    const models = yield* Model.Service
    expect(yield* test.connection.model("classifier")).toEqual(options.model)
    expect((yield* test.connection.list())[0]).toMatchObject({ custom: false, url: "https://configured.invalid/v1" })
    const saved = yield* test.connection.set({
      role: "classifier",
      url: "https://classifier.invalid/v1/",
      apiKey: "classifier-key",
    })
    expect(saved[0]).toMatchObject({ url: "https://classifier.invalid/v1", custom: true, authenticated: true })
    const classifier = yield* test.connection.model("classifier")
    expect(classifier.providerID).not.toBe(options.model.providerID)
    expect((yield* credentials.all()).map((entry) => entry.value)).toEqual([{ type: "key", key: "classifier-key" }])
    expect(JSON.stringify(yield* test.host.storage.scan({ prefix: "connection/" }))).not.toContain("classifier-key")
    expect(JSON.stringify(saved)).not.toContain("classifier-key")
    const routed = (yield* models.available(["decision"])).find((model) => model.providerID === classifier.providerID)
    expect(routed?.settings).toMatchObject({ baseURL: "https://classifier.invalid/v1" })
    expect(routed?.settings?.apiKey).toBeUndefined()
    expect(routed?.headers).toEqual({})
    expect(
      (yield* models.available(["decision"])).find((model) => model.providerID === options.model.providerID)?.settings
        ?.apiKey,
    ).toBe("source-model-key")
    yield* test.connection.set({ role: "fallback", url: "https://chat.invalid/v1", apiKey: "chat-key" })
    const fallback = yield* test.connection.model("fallback")
    expect(fallback.providerID).not.toBe(classifier.providerID)
    expect((yield* models.get(fallback.providerID, fallback.id))?.variants[0]).toEqual({
      id: Model.VariantID.make("bounded"),
      body: { reasoning_effort: "low", max_tokens: 1024 },
      headers: {},
    })
    const reopened = yield* connections(test.host, options)
    expect(yield* reopened.model("classifier")).toEqual(classifier)
    yield* test.connection.set({ role: "classifier", url: "https://classifier.invalid/v1" })
    expect(yield* test.connection.model("classifier")).toEqual(classifier)
    yield* test.connection.set({ role: "classifier", url: "https://other.invalid/v1" })
    expect((yield* reopened.list())[0]).toMatchObject({ url: "https://other.invalid/v1", authenticated: false })
    expect(yield* reopened.model("classifier")).not.toEqual(classifier)
    yield* test.connection.set({ role: "fallback", url: "https://chat.invalid/v1", apiKey: "" })
    expect((yield* test.connection.list())[1].authenticated).toBe(false)
    yield* test.connection.set({ role: "classifier" })
    expect(yield* reopened.model("classifier")).toEqual(options.model)
    for (const url of [
      "file:///tmp/secret",
      "https://user:password@host/v1",
      "https://host/v1?key=secret",
      "not-a-url",
    ]) {
      expect(Exit.isFailure(yield* test.connection.set({ role: "classifier", url }).pipe(Effect.exit))).toBe(true)
      expect(yield* test.connection.model("classifier")).toEqual(options.model)
    }
  }),
)

it.live("custom chat endpoint uses its stored key and keeps the configured model variant", () =>
  Effect.gen(function* () {
    const requests: { path: string; auth: string | null; body: unknown }[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          async fetch(request) {
            requests.push({
              path: new URL(request.url).pathname,
              auth: request.headers.get("authorization"),
              body: await request.json(),
            })
            if (new URL(request.url).pathname.endsWith("/systemone"))
              return Response.json({
                model: "decision",
                answers: {
                  permission: {
                    type: "choice",
                    choice: "approve",
                    probabilities: { approve: 0.85, deny: 0.15, escalate: 0 },
                    confidence: 0.85,
                  },
                },
              })
            return new Response(
              `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 0, model: "chat", choices: [{ index: 0, delta: { content: '{"decision":"approve","reason":"Synthetic fixture"}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const test = yield* setup
    const generate = yield* Generate.Service
    yield* test.connection.set({ role: "fallback", url: `${server.url}v1`, apiKey: "fixture-chat-key" })
    const model = yield* test.connection.model("fallback")
    expect(yield* generate.text({ model, prompt: "Synthetic connection test" })).toBe(
      '{"decision":"approve","reason":"Synthetic fixture"}',
    )
    expect(requests).toMatchObject([
      {
        path: "/v1/chat/completions",
        auth: "Bearer fixture-chat-key",
        body: { model: "chat", max_tokens: 1024, reasoning_effort: "low" },
      },
    ])
    yield* test.connection.set({ role: "fallback", url: `${server.url}v1`, apiKey: "" })
    yield* generate.text({ model: yield* test.connection.model("fallback"), prompt: "Synthetic anonymous test" })
    expect(requests[1].auth).toBeNull()
    yield* test.connection.set({ role: "classifier", url: `${server.url}v1`, apiKey: "fixture-decision-key" })
    const result = yield* generate.decisions({
      model: yield* test.connection.model("classifier"),
      input: [{ type: "text", text: "Synthetic fixture" }],
      questions: [
        {
          name: "permission",
          type: "choice",
          instructions: "Choose approve",
          choices: [{ value: "approve" }, { value: "deny" }, { value: "escalate" }],
        },
      ],
    })
    expect(result.answers[0]).toMatchObject({ choice: "approve", confidence: 0.85 })
    expect(requests[2]).toMatchObject({
      path: "/v1/systemone",
      auth: "Bearer fixture-decision-key",
      body: { model: "decision" },
    })
    yield* reviewer.effect({ ...test.host, options: { ...options, minConfidence: 0.9, defaultMode: "auto" } })
    const permission = yield* Permission.Service
    const session = yield* test.host.session.create({
      title: "Local transport fixture",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    })
    yield* addUserTask(session.id, "Inspect this synthetic checkout")
    const decision = yield* permission.ask({ sessionID: session.id, action: "shell", resources: ["git status"] })
    expect(decision.effect).toBe("allow")
    expect(requests.slice(3)).toMatchObject([
      { path: "/v1/systemone", auth: "Bearer fixture-decision-key" },
      { path: "/v1/chat/completions", auth: null },
    ])
    expect((yield* test.host.rpc(Contract).history({ sessionID: session.id }))[0]).toMatchObject({
      classifier: { threshold: 0.9 },
      fallback: { applied: true, mode: "auto" },
      decision: "approve",
    })
    yield* test.host
      .rpc(Contract)
      .saveSettings({ patch: {}, connection: { role: "classifier", url: `${server.url}v1`, apiKey: "" } })
    expect((yield* permission.ask({ sessionID: session.id, action: "shell", resources: ["git status"] })).effect).toBe(
      "allow",
    )
    expect(requests.slice(-2)).toMatchObject([
      { path: "/v1/systemone", auth: null },
      { path: "/v1/chat/completions", auth: null },
    ])
    yield* permission.close
  }),
)

it.live("custom connections resolve models defined by the later configuration plugin", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          async fetch(request) {
            const body = await request.json()
            calls.push(new URL(request.url).pathname)
            expect(request.headers.get("authorization")).toBeNull()
            if (calls.at(-1) === "/v1/systemone") {
              expect(body).toMatchObject({ model: "decision" })
              return Response.json({
                model: "decision",
                answers: {
                  permission: {
                    type: "choice",
                    choice: "approve",
                    confidence: 0.85,
                    probabilities: { approve: 0.85, deny: 0.15, escalate: 0 },
                  },
                },
              })
            }
            expect(body).toMatchObject({ model: "chat", reasoning_effort: "low", max_tokens: 1024 })
            return new Response(
              `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 0, model: "chat", choices: [{ index: 0, delta: { content: '{"decision":"approve","reason":"Synthetic fixture"}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins, "opencode.permission-review")
    // Saved overrides must also work when loaded before config contributes the source models.
    for (const role of ["classifier", "fallback"]) {
      yield* host.storage.set(`connection/${role}`, {
        url: `${server.url}v1`,
        providerID: `permission-review-${role}-fixture`,
        authenticated: false,
      })
    }
    yield* reviewer.effect({ ...host, options: { ...options, minConfidence: 0.9, defaultMode: "auto" } })
    yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({
            type: "document",
            info: Schema.decodeUnknownSync(Info)({
              providers: {
                "review-source": {
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { baseURL: "https://configured.invalid/v1", apiKey: false },
                  models: {
                    decision: { type: "decision", package: "@opencode/ai/providers/typesafe-ai/decisions" },
                    chat: { variants: [{ id: "bounded", body: { reasoning_effort: "low", max_tokens: 1024 } }] },
                  },
                },
              },
            }),
          }),
        ]),
      ),
    )
    const permission = yield* Permission.Service
    const session = yield* host.session.create({
      title: "Late config connection fixture",
      permissions: [{ action: "*", resource: "*", effect: "ask" }],
    })
    yield* addUserTask(session.id, "Inspect this synthetic checkout")
    const ask = () => permission.ask({ sessionID: session.id, action: "shell", resources: ["git status"] })
    expect((yield* ask()).effect).toBe("allow")
    expect(calls).toEqual(["/v1/systemone", "/v1/chat/completions"])
    const rpc = host.rpc(Contract)
    expect((yield* rpc.history({ sessionID: session.id }))[0]).toMatchObject({
      classifier: { confidence: 0.85 },
      fallback: { applied: true },
      decision: "approve",
    })
    yield* host.provider.reload()
    expect((yield* ask()).effect).toBe("allow")
    expect(calls).toHaveLength(4)
    // A removed source must not keep executing a cached alias or hide the lookup failure.
    yield* host.model.transform((editor) => editor.remove("review-source", "decision"))
    expect((yield* ask()).effect).toBe("ask")
    expect(calls).toHaveLength(4)
    expect((yield* rpc.history({ sessionID: session.id }))[0]?.reason).toContain(
      "Classifier model review-source/decision is unavailable",
    )
    yield* permission.close
  }),
)
