export * as SessionAuthorization from "./session-authorization.js"

import type { Question } from "./question.js"
import type { SessionMessage } from "./session-message.js"

/** Original user evidence; question wording supplies context, only answers express the user's choice. */
export type Entry =
  | {
      readonly type: "message"
      readonly id: SessionMessage.ID
      readonly at: number
      readonly text: string
      /** Assistant wording is referent context, never independent authorization. */
      readonly proposal?: { readonly id: SessionMessage.ID; readonly text: string }
    }
  | {
      readonly type: "question"
      readonly id: SessionMessage.ID
      readonly toolCallID: string
      readonly at: number
      readonly responses: ReadonlyArray<{ readonly question: Question.Prompt; readonly answers: Question.Answer }>
    }
