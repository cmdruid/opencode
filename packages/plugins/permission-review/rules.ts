import { realpath } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { PermissionReview } from "@opencode/plugin/permission"
import type { Options } from "./contract.js"

/** Only explicit, narrow request shapes bypass model review. Host denials run first. */
export const autoAllow = Effect.fn(function* (
  directory: string,
  request: PermissionReview["request"],
  options: typeof Options.Type,
) {
  if ((options.autoAllowTools ?? ["skill", "todowrite"]).some((tool) => tool === request.action))
    return { path: "tool-rule" as const, reason: `Auto-allow rule: ${request.action}.` }
  if (request.action !== "read" || options.workspaceReads === false || !request.resources.length) return
  if (request.resources.some((resource) => !resource || /[*?\[\]{}\0]/.test(resource))) return
  const paths = yield* Effect.tryPromise(() =>
    Promise.all([
      realpath(directory),
      ...request.resources.map((resource) => realpath(path.resolve(directory, resource))),
    ]),
  ).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!paths) return
  if (
    !paths.slice(1).every((target) => {
      const relative = path.relative(paths[0], target)
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    })
  )
    return
  return { path: "workspace-read" as const, reason: "Read within the session workspace." }
})
