import { expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Model } from "@opencode/plugin/effect"
import { Permission } from "../../schema/src/permission"
import { SessionID } from "../../schema/src/session-id"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { autoAllow } from "./rules"

const options = { model: Model.Ref.parse("test/model") }
const request = { id: Permission.ID.create(), sessionID: SessionID.create(), action: "read", resources: [] as string[] }
test("workspace reads resolve symlinks and reject mixed, missing, wildcard and outside targets", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "workspace")
  await mkdir(root)
  await Bun.write(path.join(root, "readme"), "safe")
  await Bun.write(path.join(tmp.path, "outside"), "outside")
  await symlink(path.join(tmp.path, "outside"), path.join(root, "escape"))
  await symlink(path.join(root, "readme"), path.join(root, "inside"))
  for (const resources of [["readme"], ["inside"], [root]])
    expect((await Effect.runPromise(autoAllow(root, { ...request, resources }, options)))?.path).toBe("workspace-read")
  for (const resources of [[], ["missing"], ["*"], ["../outside"], ["escape"], ["readme", "escape"]])
    expect(await Effect.runPromise(autoAllow(root, { ...request, resources }, options))).toBeUndefined()
  expect(
    await Effect.runPromise(
      autoAllow(root, { ...request, resources: ["readme"] }, { ...options, workspaceReads: false }),
    ),
  ).toBeUndefined()
})
test("only the explicitly configured tool actions bypass models", async () => {
  for (const action of ["skill", "todowrite"])
    expect((await Effect.runPromise(autoAllow("/tmp", { ...request, action }, options)))?.path).toBe("tool-rule")
  for (const action of ["shell", "sudo", "webfetch", "mcp.skill", "edit", "external_directory"])
    expect(await Effect.runPromise(autoAllow("/tmp", { ...request, action }, options))).toBeUndefined()
  expect(
    await Effect.runPromise(autoAllow("/tmp", { ...request, action: "skill" }, { ...options, autoAllowTools: [] })),
  ).toBeUndefined()
})
