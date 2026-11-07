import { Schema } from "effect"
import { Assessment } from "../contract"
import { classifierDecision } from "../review"

// Offline routing inspection only. No client, network, model, permission reply or tool executor.
const file = process.argv[2]
if (!file) throw new Error("Usage: bun script/replay.ts <diagnostics.json> [approval-threshold]")
const input = Schema.decodeUnknownSync(Schema.Struct({ format: Schema.Literal(1), records: Schema.Array(Assessment) }))(
  await Bun.file(file).json(),
)
const threshold = process.argv[3] === undefined ? undefined : Number(process.argv[3])
if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1))
  throw new Error("Threshold must be between 0 and 1")
for (const record of input.records) {
  const result = record.classifier
    ? classifierDecision({ ...record.classifier, threshold: threshold ?? record.classifier.threshold })
    : undefined
  console.log(
    JSON.stringify({
      requestID: record.requestID,
      recorded: record.decision,
      path: record.path,
      classifier: result?.decision,
      reviewer: record.fallback?.decision,
      reply: record.reply?.decision,
      note: "Recorded outputs only; a changed threshold may require a reviewer call absent from this capture. This is not a model accuracy benchmark.",
    }),
  )
}
