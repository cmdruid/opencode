import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"

export const Request = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  host: Schema.String,
  user: Schema.String,
  socket: Schema.String,
})
export type Request = typeof Request.Type

const Id = Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String }))

export default Rpc.define({
  id: "experimental.sudo",
  methods: {
    list: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Array(Request)),
    },
    cancel: { input: Id, output: Schema.toStandardSchemaV1(Schema.Boolean) },
  },
  events: {
    requested: { schema: Schema.toStandardSchemaV1(Request) },
    closed: { schema: Id },
  },
})
