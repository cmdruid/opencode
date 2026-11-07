import { expect, jest, test } from "bun:test"
import { connect } from "node:net"
import { once } from "node:events"
import { stat } from "node:fs/promises"
import { createRequests } from "../requests"

// The production broker requires Unix-domain sockets and Unix filesystem permissions.
const unixTest = test.skipIf(process.platform === "win32")
const info = {
  id: crypto.randomUUID(),
  sessionID: "session",
  command: "id",
  cwd: "/tmp",
  host: "server",
  user: "owner",
}

unixTest("approval and claimed handoffs stay pending until the user responds", async () => {
  jest.useFakeTimers()
  const requests = createRequests()
  const pending = await requests.ask(info, 1000, new AbortController().signal)
  try {
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(requests.list("session")).toEqual([pending.request])
    const native = connect(pending.request.socket)
    const data = once(native, "data")
    native.write(info.id)
    const [metadata] = await data
    expect(metadata.readUInt32BE(metadata.length - 4)).toBe(1000)
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(requests.list("session")).toEqual([pending.request])
    expect(native.destroyed).toBe(false)
    const result = Buffer.alloc(13)
    result[0] = 88
    result.writeUInt32BE(8, 1)
    native.write(result)
    expect(await pending.result).toEqual({ output: "", exit: 0, timedOut: false, truncated: false })
    expect(requests.list("session")).toEqual([])
  } finally {
    requests.close()
    jest.useRealTimers()
    await pending.result
  }
})

unixTest("private socket claims once and carries only command metadata and output", async () => {
  const requests = createRequests()
  const pending = await requests.ask(info, 1000, new AbortController().signal)
  try {
    expect(requests.list("session")).toEqual([pending.request])
    expect(requests.list("other")).toEqual([])
    expect((await stat(pending.request.socket)).mode & 0o777).toBe(0o600)
    expect((await stat(pending.request.socket.replace(/\/[^/]+$/, ""))).mode & 0o777).toBe(0o700)
    const first = connect(pending.request.socket)
    const data = once(first, "data")
    first.write(info.id)
    const [metadata] = await data
    expect(metadata.subarray(0, 8).toString()).toBe("OCSUDO1\0")
    expect(metadata.toString()).toContain("/tmp")
    const duplicate = connect(pending.request.socket)
    duplicate.write(info.id)
    await once(duplicate, "close")
    const output = Buffer.from("command-output")
    const frame = Buffer.alloc(5 + output.length + 13)
    frame[0] = 79
    frame.writeUInt32BE(output.length, 1)
    output.copy(frame, 5)
    frame[5 + output.length] = 88
    frame.writeUInt32BE(8, 6 + output.length)
    frame.writeUInt32BE(7, 10 + output.length)
    first.write(frame)
    expect(await pending.result).toEqual({ output: "command-output", exit: 7, truncated: false, timedOut: false })
    expect(requests.list("session")).toEqual([])
    expect(requests.cancel(info.id)).toBe(false)
    expect(await Bun.file(pending.request.socket).exists()).toBe(false)
  } finally {
    requests.close()
  }
})

unixTest("abort and shutdown close local handoffs; late claims cannot run a command", async () => {
  const requests = createRequests()
  const controller = new AbortController()
  const first = await requests.ask(info, 1000, controller.signal)
  const second = await requests.ask({ ...info, id: crypto.randomUUID(), sessionID: "other" }, 1000, controller.signal)
  controller.abort()
  expect(await first.result).toBeUndefined()
  expect(await second.result).toBeUndefined()
  expect(requests.list("session")).toEqual([])
  expect(requests.cancel(info.id)).toBe(false)
  await expect(requests.ask(info, 1000, controller.signal)).rejects.toThrow()
  const third = await requests.ask(info, 1000, new AbortController().signal)
  requests.close()
  expect(await third.result).toBeUndefined()
})

unixTest("wrong claims are rejected and malformed result frames cancel the request", async () => {
  const requests = createRequests()
  const pending = await requests.ask(info, 1000, new AbortController().signal)
  try {
    const wrong = connect(pending.request.socket)
    wrong.write(crypto.randomUUID())
    await once(wrong, "close")
    expect(requests.list("session")).toHaveLength(1)
    const native = connect(pending.request.socket)
    const data = once(native, "data")
    native.write(info.id)
    await data
    native.write(Buffer.from([80, 0, 1, 0, 0]))
    expect(await pending.result).toBeUndefined()
  } finally {
    requests.close()
  }
})
