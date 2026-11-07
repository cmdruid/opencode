import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { Rpc } from "@opencode/core/rpc"
import { Tool } from "@opencode/core/tool"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../../../core/test/fixture/location"
import { testEffect } from "../../../core/test/lib/effect"
import { imagePassthrough } from "../../../core/test/lib/image"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "../../../core/test/lib/tool"
import { host } from "../../../core/test/plugin/host"
import Sudo from "../rpc"
import plugin from "../index"

const current = location({ directory: AbsolutePath.make(process.cwd()) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, Rpc.node]), [
    Image.node.replace(imagePassthrough),
    Location.node.replace(Layer.succeed(Location.Service, current)),
  ]),
)

// Native sudo requires a Unix server and a TUI on the same host.
const unixTest = process.platform === "win32" ? it.live.skip : it.live
unixTest("the real tool registry and RPC route publish metadata, accept cancellation, and remove the request", () =>
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const tools = yield* Tool.Service
    const assertions: string[] = []
    yield* registerToolPlugin(fromPromise(plugin), {
      location: current,
      rpc: Object.assign(rpc.client, { register: rpc.register }),
      permission: {
        ...host().permission,
        assert: (input) =>
          Effect.sync(() => {
            assertions.push(input.action)
          }),
      },
    })
    const definitions = yield* toolDefinitions(tools)
    const definition = definitions.find((value) => value.name === "sudo")
    expect(definition).toBeDefined()
    expect(definition?.inputSchema).not.toHaveProperty("properties.password")
    const client = rpc.client(Sudo)
    const requested = yield* client.events
      .subscribe("requested")
      .pipe(Stream.runHead, Effect.forkChild({ startImmediately: true }))
    const result = yield* executeTool(tools, {
      sessionID: Session.ID.make("ses_sudo_test"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "sudo-call",
        name: "sudo",
        input: { reason: "Inspect the privileged service identity.", command: "id -u" },
      },
    }).pipe(Effect.forkChild({ startImmediately: true }))
    const event = Option.getOrThrow(yield* Fiber.join(requested))
    expect(assertions).toEqual(["sudo"])
    expect(event.data.command).toBe("id -u")
    expect(event.data.reason).toBe("Inspect the privileged service identity.")
    expect(yield* client.list({ sessionID: "ses_sudo_test" })).toEqual([event.data])
    expect(yield* client.cancel({ id: event.data.id })).toBe(true)
    expect(yield* Fiber.join(result)).toMatchObject({ status: "error" })
    expect(yield* client.list({ sessionID: "ses_sudo_test" })).toEqual([])
    expect(yield* client.cancel({ id: event.data.id })).toBe(false)
  }),
)

unixTest("a denied sudo permission stops before requesting a password", () =>
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const tools = yield* Tool.Service
    yield* registerToolPlugin(fromPromise(plugin), {
      location: current,
      rpc: Object.assign(rpc.client, { register: rpc.register }),
      permission: {
        ...host().permission,
        assert: () => Effect.fail(new Tool.Error({ message: "Permission denied: sudo" })),
      },
    })
    const result = yield* executeTool(tools, {
      sessionID: Session.ID.make("ses_sudo_denied"),
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "sudo-denied",
        name: "sudo",
        input: { reason: "Inspect the privileged service identity.", command: "id -u" },
      },
    })
    expect(result).toMatchObject({ status: "error", error: { message: "Permission denied: sudo" } })
    expect(yield* rpc.client(Sudo).list({ sessionID: "ses_sudo_denied" })).toEqual([])
  }),
)

for (const reason of [undefined, "", " \t\n", "x".repeat(501)]) {
  unixTest(`invalid reason ${JSON.stringify(reason)} is rejected before permission or admission`, () =>
    Effect.gen(function* () {
      const rpc = yield* Rpc.Service
      const tools = yield* Tool.Service
      const permissions: string[] = []
      yield* registerToolPlugin(fromPromise(plugin), {
        location: current,
        rpc: Object.assign(rpc.client, { register: rpc.register }),
        permission: {
          ...host().permission,
          assert: () =>
            Effect.sync(() => {
              permissions.push("asserted")
            }),
        },
      })
      const result = yield* executeTool(tools, {
        sessionID: Session.ID.make("ses_sudo_invalid"),
        ...toolIdentity,
        call: { type: "tool-call", id: "invalid", name: "sudo", input: { command: "id -u", reason } },
      })
      expect(result).toMatchObject({ status: "error" })
      expect(permissions).toEqual([])
      expect(yield* rpc.client(Sudo).list({ sessionID: "ses_sudo_invalid" })).toEqual([])
    }),
  )
}
