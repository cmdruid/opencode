import type { Plugin } from "@opencode/plugin/effect"
import { Cause, Clock, Effect, Exit, Option, Schema, Semaphore } from "effect"
import { Assessment } from "./contract.js"

export const retention = {
  count: 500,
  bytes: 20 * 1024 * 1024,
  ageMs: 14 * 24 * 60 * 60 * 1000,
  recordBytes: 256 * 1024,
}
const lock = Semaphore.makeUnsafe(1)
const Index = Schema.Array(
  Schema.Struct({ id: Schema.String, sessionID: Schema.String, at: Schema.Number, bytes: Schema.Number }),
)

/** Redaction applies only to stored/exported copies, never to the evidence sent to the reviewer. */
export function sanitize(value: unknown) {
  let redacted = false
  let truncated = false
  const json = JSON.stringify(value, (key, item) => {
    if (
      /^(authorization|cookie|set-cookie|password|passwd|secret|token|access_token|api[-_]?key|credential)$/i.test(key)
    ) {
      redacted = true
      return "[REDACTED]"
    }
    if (typeof item !== "string") return item
    const clean = item
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,})\b/g, "[REDACTED]")
      .replace(/((?:api[_-]?key|password|passwd|access[_-]?token|secret)\s*[=:]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    redacted ||= clean !== item
    truncated ||= clean.length > 64_000
    return clean.length > 64_000 ? clean.slice(0, 64_000) + "…[TRUNCATED]" : clean
  })
  return { value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(json), redacted, truncated }
}

export function capture() {
  const calls: { kind: string; durationMs: number; payload: Schema.Json; redacted: boolean; truncated: boolean }[] = []
  const run = <A, E>(kind: string, input: unknown, effect: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const clean = sanitize({
              input,
              status: Exit.isSuccess(exit) ? "completed" : "failed",
              ...(Exit.isSuccess(exit) ? { output: exit.value } : { error: Cause.pretty(exit.cause) }),
            })
            calls.push({
              kind,
              durationMs: (yield* Clock.currentTimeMillis) - started,
              payload: clean.value,
              redacted: clean.redacted,
              truncated: clean.truncated,
            })
          }),
        ),
      )
    })
  return { calls, run }
}

/** One global plugin index; histories never rescan unrelated records after migration. */
export function diagnostics(storage: Plugin.Context["storage"]) {
  const read = Effect.gen(function* () {
    const saved = yield* storage.get("diagnostics/index")
    const parsed = Schema.decodeUnknownOption(Index)(saved)
    if (Option.isSome(parsed)) return [...parsed.value]
    const entries: (typeof Index.Type)[number][] = []
    let after: string | undefined
    do {
      const page = yield* storage.scan({ prefix: "review/", after, limit: 100 })
      for (const entry of page.entries) {
        const decoded = Schema.decodeUnknownOption(Assessment)(entry.value)
        if (Option.isNone(decoded)) {
          yield* storage.remove(entry.key)
          continue
        }
        const record = bounded(decoded.value)
        yield* storage.set(entry.key, record)
        entries.push({
          id: entry.key.slice(7),
          sessionID: decoded.value.sessionID,
          at: decoded.value.at,
          bytes: bytes(record),
        })
      }
      after = page.next
    } while (after)
    return entries
  })
  const prune = Effect.fn(function* (entries: typeof Index.Type) {
    const now = yield* Clock.currentTimeMillis
    let size = 2 // Index array brackets; each entry also budgets one separator.
    const keep: (typeof Index.Type)[number][] = []
    for (const item of [...entries].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))) {
      const cost = item.bytes + bytes(item) + 1
      if (item.at < now - retention.ageMs || keep.length >= retention.count || size + cost > retention.bytes) {
        yield* storage.remove(`review/${item.id}`)
        continue
      }
      size += cost
      keep.push(item)
    }
    yield* storage.set("diagnostics/index", keep)
    return keep
  })
  const put = (entry: Assessment) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = bounded(entry)
        const entries = (yield* read).filter((item) => item.id !== entry.requestID)
        // Publish the index first: interruption may leave a missing record, never an unindexed large payload.
        const keep = yield* prune([
          ...entries,
          { id: entry.requestID, sessionID: entry.sessionID, at: entry.at, bytes: bytes(record) },
        ])
        if (keep.some((item) => item.id === entry.requestID)) yield* storage.set(`review/${entry.requestID}`, record)
      }),
    )
  const list = (sessionID: string, limit = 50) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* prune(yield* read)
        const records = yield* Effect.forEach(
          entries.filter((item) => item.sessionID === sessionID).slice(0, limit),
          (item) => storage.get(`review/${item.id}`),
        )
        return records.flatMap((record) => {
          const decoded = Schema.decodeUnknownOption(Assessment)(record)
          return Option.isSome(decoded) ? [decoded.value] : []
        })
      }),
    )
  const reply = (id: string, decision: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* prune(yield* read)
        if (!entries.some((item) => item.id === id)) return
        const decoded = Schema.decodeUnknownOption(Assessment)(yield* storage.get(`review/${id}`))
        if (Option.isNone(decoded)) return
        const record = bounded({ ...decoded.value, reply: { decision, at: yield* Clock.currentTimeMillis } })
        const keep = yield* prune(entries.map((item) => (item.id === id ? { ...item, bytes: bytes(record) } : item)))
        if (keep.some((item) => item.id === id)) yield* storage.set(`review/${id}`, record)
      }),
    )
  return {
    put,
    list,
    reply,
    sweep: lock.withPermits(1)(
      Effect.gen(function* () {
        yield* prune(yield* read)
      }),
    ),
  }
}

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
function bounded(entry: Assessment): Assessment {
  const clean = sanitize(entry)
  const value = Schema.decodeUnknownSync(Assessment)(clean.value)
  const record = {
    ...value,
    diagnostics: {
      ...value.diagnostics,
      redacted: clean.redacted || value.diagnostics?.redacted === true,
      truncated: clean.truncated || value.diagnostics?.truncated === true,
    },
  }
  if (bytes(record) <= retention.recordBytes) return record
  return {
    requestID: record.requestID,
    sessionID: record.sessionID,
    action: record.action.slice(0, 200),
    resources: record.resources?.slice(0, 10).map((resource) => resource.slice(0, 200)),
    decision: record.decision,
    reason: record.reason.slice(0, 1000),
    model: record.model,
    mode: record.mode,
    shadow: record.shadow,
    at: record.at,
    durationMs: record.durationMs,
    path: record.path,
    reply: record.reply,
    diagnostics: {
      redacted: record.diagnostics.redacted,
      truncated: true,
      omission: "Record exceeded 256 KiB; model payloads omitted.",
    },
  }
}
