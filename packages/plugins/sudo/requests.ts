import { chmod, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import type { Socket } from "node:net"
import { StringDecoder } from "node:string_decoder"
import type { Request } from "./rpc"

export type Result = { output: string; exit: number; timedOut: boolean; truncated: boolean }

/** The local socket transports commands and post-authentication output. It has no credential message. */
export function createRequests() {
  const pending = new Map<string, { info: Request; finish: (result?: Result) => void }>()
  return {
    list: (sessionID: string) =>
      [...pending.values()].flatMap((entry) => (entry.info.sessionID === sessionID ? [entry.info] : [])),
    async ask(info: Omit<Request, "socket">, timeout: number, signal: AbortSignal) {
      signal.throwIfAborted()
      const directory = await mkdtemp("/tmp/opencode-sudo-")
      const request = { ...info, socket: `${directory}/request.sock` }
      const result = Promise.withResolvers<Result | undefined>()
      const connections = new Set<Socket>()
      const state = { done: false, claimed: false, output: "", truncated: false }
      const decoder = new StringDecoder("utf8")
      const append = (text: string) => {
        state.output += text
        if (state.output.length <= 65536) return
        state.truncated = true
        state.output = state.output.slice(-65536)
      }
      const cancel = () => finish()
      const timer = setTimeout(cancel, Math.min(2147483647, 300_000 + timeout))
      const finish = (value?: Result) => {
        if (state.done) return
        state.done = true
        pending.delete(info.id)
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
        connections.forEach((connection) => connection.destroy())
        server.close()
        void rm(directory, { recursive: true, force: true }).then(
          () => result.resolve(value),
          () => result.resolve(value),
        )
      }
      const server = createServer((connection) => {
        connections.add(connection)
        connection.setTimeout(5000, () => connection.destroy())
        let buffer = Buffer.alloc(0)
        let claimed = false
        connection.on("error", () => connection.destroy())
        connection.on("close", () => {
          connections.delete(connection)
          if (claimed) finish()
        })
        connection.on("data", (data) => {
          buffer = Buffer.concat([buffer, data])
          if (!claimed) {
            if (buffer.length < 36) return
            if (state.done || state.claimed || buffer.subarray(0, 36).toString() !== info.id) {
              connection.destroy()
              return
            }
            claimed = true
            state.claimed = true
            buffer = buffer.subarray(36)
            connection.setTimeout(0)
            const fields = [Buffer.from(info.cwd), Buffer.from(info.command)].flatMap((value) => {
              const length = Buffer.alloc(4)
              length.writeUInt32BE(value.length)
              return [length, value]
            })
            const limit = Buffer.alloc(4)
            limit.writeUInt32BE(timeout)
            connection.write(Buffer.concat([Buffer.from("OCSUDO1\0"), ...fields, limit]))
          }
          while (buffer.length >= 5) {
            const type = buffer[0]
            const size = buffer.readUInt32BE(1)
            if ((type !== 79 && type !== 88) || size > 4096 || (type === 88 && size !== 8)) return finish()
            if (buffer.length < size + 5) return
            const payload = buffer.subarray(5, size + 5)
            buffer = buffer.subarray(size + 5)
            if (type === 79) {
              append(decoder.write(payload))
              continue
            }
            append(decoder.end())
            finish({
              output: state.output,
              exit: payload.readUInt32BE(0),
              timedOut: payload.readUInt32BE(4) === 1,
              truncated: state.truncated,
            })
            return
          }
        })
      })
      server.on("error", cancel)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(request.socket, () => {
          server.removeListener("error", reject)
          resolve()
        })
      })
        .then(() => chmod(request.socket, 0o600))
        .catch((error) => {
          finish()
          throw error
        })
      if (signal.aborted) finish()
      if (!state.done) {
        pending.set(info.id, { info: request, finish })
        signal.addEventListener("abort", cancel, { once: true })
      }
      return { request, result: result.promise }
    },
    cancel(id: string) {
      const entry = pending.get(id)
      if (!entry) return false
      entry.finish()
      return true
    },
    close() {
      pending.forEach((entry) => entry.finish())
    },
  }
}
