import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// Compile JSX before publication: the runtime Solid transformer excludes node_modules.
const result = await Bun.build({
  entrypoints: [new URL("../tui.tsx", import.meta.url).pathname],
  outdir: new URL("..", import.meta.url).pathname,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
})
if (!result.success) throw new AggregateError(result.logs, "Could not compile the sudo TUI")
