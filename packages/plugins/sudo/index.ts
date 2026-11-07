import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { hostname, userInfo } from "node:os"
import { resolve } from "node:path"
import { stat } from "node:fs/promises"
import { createRequests } from "./requests"
import Sudo from "./rpc"

export default Plugin.define({
  id: "experimental.sudo",
  async setup(ctx) {
    const requests = createRequests()
    const rpc = await ctx.rpc.register(Sudo, {
      list: async (input) => requests.list(input.sessionID),
      cancel: async (input) => requests.cancel(input.id),
    })
    const registration = await ctx.tool.transform((editor) =>
      editor.add({
        name: "sudo",
        options: { codemode: false },
        description:
          "Experimental: run a command as root on the OpenCode server using native terminal authentication. May change without compatibility guarantees. Do not include leading sudo or a password. The user reviews the exact command and enters their password outside the conversation. Requires the plugin TUI on the Linux x64 server host; works over SSH/tmux. Commands run in /bin/sh with stdin closed; interactive commands are unsupported. Never ask for the password in chat or use shell to bypass a cancellation.",
        input: Schema.toStandardSchemaV1(
          Schema.Struct({
            command: Schema.String.check(Schema.isMinLength(1)),
            workdir: Schema.optionalKey(Schema.String),
            timeout: Schema.optionalKey(
              Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2147483647)),
            ).annotate({
              description:
                "Command timeout in milliseconds, excluding user approval and sudo authentication. Default: 120000.",
            }),
          }),
        ),
        output: Schema.toStandardSchemaV1(
          Schema.Struct({
            output: Schema.String,
            exit: Schema.Number,
            timedOut: Schema.Boolean,
            truncated: Schema.Boolean,
          }),
        ),
        async execute(input, context) {
          if (process.platform === "win32")
            throw new Error("The sudo plugin requires a Unix server (Linux, macOS, or WSL).")
          if (!input.command.trim()) throw new Error("A command is required.")
          if (input.command.includes("\0") || Buffer.byteLength(input.command) > 65536)
            throw new Error("Command contains NUL or exceeds 65536 bytes.")
          const cwd = resolve(ctx.location.directory, input.workdir ?? ".")
          if (cwd.includes("\0") || Buffer.byteLength(cwd) > 65536) throw new Error("Invalid working directory.")
          await ctx.permission.assert({
            action: "sudo",
            resources: [input.command],
            metadata: { command: input.command, cwd },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
          if (!(await stat(cwd)).isDirectory()) throw new Error("The working directory is not a directory.")
          const request = {
            id: crypto.randomUUID(),
            sessionID: context.sessionID,
            command: input.command,
            cwd,
            host: hostname(),
            user: userInfo().username,
          }
          const pending = await requests.ask(request, input.timeout ?? 120_000, context.signal)
          const output = await rpc.events
            .emit("requested", pending.request)
            .then(() => pending.result)
            .finally(async () => {
              requests.cancel(request.id)
              await rpc.events.emit("closed", { id: request.id })
            })
          context.signal.throwIfAborted()
          if (!output) throw new Error("Sudo was cancelled or the native helper disconnected.")
          return {
            output,
            content: [
              output.output,
              `exit ${output.exit ?? "signal"}`,
              ...(output.timedOut ? ["Command exceeded its timeout."] : []),
              ...(output.truncated ? ["Output truncated to the last 65536 characters."] : []),
            ]
              .filter(Boolean)
              .join("\n"),
          }
        },
      }),
    )
    return async () => {
      requests.close()
      await registration.dispose()
      await rpc.dispose()
    }
  },
})
