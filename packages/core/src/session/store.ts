export * as SessionStore from "./store.js"

import { and, asc, desc, eq, gt, isNotNull, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Project } from "@opencode/schema/project"
import { Workspace } from "@opencode/schema/workspace"
import { AbsolutePath, PositiveInt, RelativePath } from "@opencode/schema/schema"
import { Database } from "../database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionHistory } from "./history.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { Session } from "@opencode/schema/session"
import { SessionMessageTable, SessionPartTable, SessionTable } from "./sql.js"
import { Question } from "@opencode/schema/question"
import type { SessionAuthorization } from "@opencode/schema/session-authorization"
import { fromRow } from "./info.js"

const ListInputBase = {
  workspaceID: Workspace.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  parentID: Schema.NullOr(Session.ID).pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
  anchor: Session.ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

export type MessagesInput = {
  sessionID: Session.ID
  limit?: number
  order?: "asc" | "desc"
  type?: SessionMessage.Type
  cursor?: {
    id: SessionMessage.ID
    direction: "previous" | "next"
  }
}

const QuestionReply = Schema.Struct({
  id: Schema.String,
  state: Schema.Struct({
    input: Schema.Struct({ questions: Schema.Array(Question.Prompt).check(Schema.isMinLength(1)) }),
    metadata: Schema.Struct({ answers: Schema.Array(Question.Answer) }),
  }),
  time: Schema.Struct({ completed: Schema.Finite }),
})

export interface Interface {
  readonly authorization: (input: {
    sessionID: Session.ID
    before?: SessionMessage.ID
  }) => Effect.Effect<ReadonlyArray<SessionAuthorization.Entry>>
  readonly get: (sessionID: Session.ID) => Effect.Effect<Session.Info | undefined>
  readonly list: (input?: ListInput) => Effect.Effect<Session.Info[]>
  readonly messages: (input: MessagesInput) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly context: (sessionID: Session.ID) => Effect.Effect<SessionMessage.Info[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.Info } | undefined>
  /** {@link Interface.messages} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
  readonly messagesWithRefs: (input: MessagesInput) => Effect.Effect<SessionMessage.MediaInfo[], MessageDecodeError>
  /** {@link Interface.message} for clients that fetch media themselves. */
  readonly messageWithRefs: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: Session.ID; readonly message: SessionMessage.MediaInfo } | undefined>
  /**
   * Top-level Sessions holding an execution claim. Recoverable background
   * children are resumed separately through their durable Job records.
   */
  readonly listSuspended: () => Effect.Effect<ReadonlyArray<Session.ID>>
  /**
   * Records the execution claim: the durable write-ahead intent that a turn is
   * (or was) in flight. Set when execution starts; a claim that survives to the
   * next boot marks a turn that never completed — its process crashed or shut
   * down mid-turn.
   */
  readonly claim: (sessionID: Session.ID) => Effect.Effect<void>
  /** Releases the claim and resets resume accounting. Terminal events call this on commit. */
  readonly release: (sessionID: Session.ID) => Effect.Effect<void>
  /**
   * Clears orphaned child claims except children owned by recoverable
   * background subagent jobs.
   */
  readonly releaseChildClaims: (recoverable: ReadonlyArray<Session.ID>) => Effect.Effect<void>
  /**
   * Durably counts one more resume of an orphaned claim, returning the new
   * total — or undefined when the Session no longer exists.
   */
  readonly countResume: (sessionID: Session.ID) => Effect.Effect<number | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    /** One page of a session's message rows, oldest first within the page when paging backwards. */
    const messageRows = Effect.fnUntraced(function* (input: MessagesInput) {
      const direction = input.cursor?.direction ?? "next"
      const requestedOrder = input.order ?? "desc"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const anchor = input.cursor
        ? yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      if (input.cursor && !anchor) return []
      const boundary = anchor
        ? order === "asc"
          ? gt(SessionMessageTable.seq, anchor.seq)
          : lt(SessionMessageTable.seq, anchor.seq)
        : undefined
      const query = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, input.sessionID),
            boundary,
            input.type === undefined ? undefined : eq(SessionMessageTable.type, input.type),
          ),
        )
        .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
      const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
      return direction === "previous" ? rows.toReversed() : rows
    })

    const messageRow = (messageID: SessionMessage.ID) =>
      db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie)

    return Service.of({
      get: Effect.fnUntraced(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      list: Effect.fn("SessionStore.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if ("project" in input && input.subpath !== undefined) conditions.push(eq(SessionTable.path, input.subpath))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.parentID !== undefined)
          conditions.push(
            input.parentID === null ? isNull(SessionTable.parent_id) : eq(SessionTable.parent_id, input.parentID),
          )
        if (input.archived !== undefined)
          conditions.push(input.archived ? isNotNull(SessionTable.time_archived) : isNull(SessionTable.time_archived))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      authorization: Effect.fn("SessionStore.authorization")(function* (input) {
        const boundary = input.before
          ? lt(
              SessionMessageTable.seq,
              db
                .select({ seq: SessionMessageTable.seq })
                .from(SessionMessageTable)
                .where(
                  and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.before)),
                ),
            )
          : undefined
        // Read only text and question parts; never hydrate historical tool output or media blobs.
        const messages = yield* db
          .select({
            id: SessionMessageTable.id,
            at: SessionMessageTable.time_created,
            seq: SessionMessageTable.seq,
            text: sql<string>`json_extract(${SessionMessageTable.data}, '$.text')`,
          })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.type, "user"), boundary),
          )
          .orderBy(asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        // Only completed assistant text before the reply can explain it. Exclude reasoning,
        // tool output and text appended after a user steers an unfinished step.
        const proposals = yield* db
          .select({
            id: SessionMessageTable.id,
            seq: SessionMessageTable.seq,
            completed: sql<number>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
            text: sql<string>`json_extract(part.value, '$.text')`,
          })
          .from(SessionMessageTable)
          .innerJoin(sql`json_each(${SessionMessageTable.data}, '$.content') as part`, sql`true`)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              boundary,
              eq(SessionMessageTable.type, "assistant"),
              sql`json_extract(part.value, '$.type') = 'text'`,
              sql`json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq), sql`part.key`)
          .all()
          .pipe(Effect.orDie)
        const storedProposals = yield* db
          .select({
            id: SessionMessageTable.id,
            seq: SessionMessageTable.seq,
            completed: sql<number>`json_extract(${SessionMessageTable.data}, '$.time.completed')`,
            text: sql<string>`json_extract(${SessionPartTable.data}, '$.text')`,
          })
          .from(SessionPartTable)
          .innerJoin(SessionMessageTable, eq(SessionMessageTable.id, SessionPartTable.message_id))
          .where(
            and(
              eq(SessionPartTable.session_id, input.sessionID),
              boundary,
              eq(SessionMessageTable.type, "assistant"),
              eq(SessionPartTable.type, "text"),
              sql`json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq), asc(SessionPartTable.ordinal))
          .all()
          .pipe(Effect.orDie)
        const preceding = [...proposals, ...storedProposals].sort((a, b) => a.seq - b.seq)
        const parts = yield* db
          .select({ id: SessionPartTable.message_id, data: SessionPartTable.data })
          .from(SessionPartTable)
          .innerJoin(SessionMessageTable, eq(SessionMessageTable.id, SessionPartTable.message_id))
          .where(
            and(
              eq(SessionPartTable.session_id, input.sessionID),
              boundary,
              eq(SessionPartTable.type, "tool"),
              sql`json_extract(${SessionPartTable.data}, '$.name') = 'question'`,
              sql`json_extract(${SessionPartTable.data}, '$.state.status') = 'completed'`,
              sql`coalesce(json_extract(${SessionPartTable.data}, '$.executed'), 0) = 0`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq), asc(SessionPartTable.ordinal))
          .all()
          .pipe(Effect.orDie)
        // Older/default hosts store assistant parts inline; read both supported storage layouts.
        const inline = yield* db
          .select({
            id: SessionMessageTable.id,
            data: sql`part.value`.mapWith(SessionPartTable.data),
          })
          .from(SessionMessageTable)
          .innerJoin(sql`json_each(${SessionMessageTable.data}, '$.content') as part`, sql`true`)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              eq(SessionMessageTable.type, "assistant"),
              boundary,
              sql`json_extract(part.value, '$.type') = 'tool'`,
              sql`json_extract(part.value, '$.name') = 'question'`,
              sql`json_extract(part.value, '$.state.status') = 'completed'`,
              sql`coalesce(json_extract(part.value, '$.executed'), 0) = 0`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq), sql`part.key`)
          .all()
          .pipe(Effect.orDie)
        const answers = [...parts, ...inline].flatMap<SessionAuthorization.Entry>((part) => {
          const reply = Schema.decodeUnknownOption(QuestionReply)(part.data)
          if (Option.isNone(reply)) return []
          const questions = reply.value.state.input.questions
          const answers = reply.value.state.metadata.answers
          if (questions.length !== answers.length) return []
          return [
            {
              type: "question",
              id: part.id,
              toolCallID: reply.value.id,
              at: reply.value.time.completed,
              responses: questions.map((question, index) => ({ question, answers: answers[index] })),
            },
          ]
        })
        // An answer can arrive after a later user message while its assistant step is still open.
        return [
          ...messages.map((message, index) => {
            const eligible = preceding.filter(
              (part) =>
                part.seq < message.seq && part.seq > (messages[index - 1]?.seq ?? -1) && part.completed <= message.at,
            )
            const last = eligible.at(-1)
            return {
              type: "message" as const,
              id: message.id,
              at: message.at,
              text: message.text,
              ...(last
                ? {
                    proposal: {
                      id: last.id,
                      text: eligible
                        .filter((part) => part.id === last.id)
                        .map((part) => part.text)
                        .join("\n"),
                    },
                  }
                : {}),
            }
          }),
          ...answers,
        ].sort((a, b) => a.at - b.at)
      }),
      messages: Effect.fn("SessionStore.messages")(function* (input) {
        return yield* SessionHistory.decodeMessageRows(db, yield* messageRows(input))
      }),
      messagesWithRefs: Effect.fn("SessionStore.messagesWithRefs")(function* (input) {
        return yield* SessionHistory.decodeMessageRowsWithRefs(db, yield* messageRows(input))
      }),
      context: Effect.fn("SessionStore.context")((sessionID) => SessionHistory.load(db, sessionID, "latest")),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      messageWithRefs: Effect.fn("SessionStore.messageWithRefs")(function* (messageID) {
        const row = yield* messageRow(messageID)
        if (!row) return undefined
        const [message] = yield* SessionHistory.decodeMessageRowsWithRefs(db, [row]).pipe(Effect.orDie)
        return message && { sessionID: row.session_id, message }
      }),
      listSuspended: Effect.fn("SessionStore.listSuspended")(function* () {
        return yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(and(isNotNull(SessionTable.time_suspended), isNull(SessionTable.parent_id)))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map((row) => row.sessionID)),
          )
      }),
      claim: Effect.fn("SessionStore.claim")(function* (sessionID) {
        // The null guard makes re-claiming a still-claimed Session a zero-row
        // no-op (a resumed turn re-claims through the same started hook).
        // Claim bookkeeping never counts as user activity: time_updated is
        // pinned so session ordering only moves on real changes.
        yield* db
          .update(SessionTable)
          .set({ time_suspended: Date.now(), time_updated: sql`${SessionTable.time_updated}` })
          .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.time_suspended)))
          .run()
          .pipe(Effect.orDie)
      }),
      release: Effect.fn("SessionStore.release")(function* (sessionID) {
        yield* db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
      releaseChildClaims: Effect.fn("SessionStore.releaseChildClaims")((recoverable) =>
        db
          .update(SessionTable)
          .set({ time_suspended: null, resume_attempts: 0, time_updated: sql`${SessionTable.time_updated}` })
          .where(
            and(
              isNotNull(SessionTable.time_suspended),
              isNotNull(SessionTable.parent_id),
              recoverable.length > 0 ? notInArray(SessionTable.id, Array.from(recoverable)) : undefined,
            ),
          )
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      ),
      countResume: Effect.fn("SessionStore.countResume")(function* (sessionID) {
        const row = yield* db
          .update(SessionTable)
          .set({
            resume_attempts: sql`${SessionTable.resume_attempts} + 1`,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(eq(SessionTable.id, sessionID))
          .returning({ attempts: SessionTable.resume_attempts })
          .get()
          .pipe(Effect.orDie)
        return row?.attempts
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
