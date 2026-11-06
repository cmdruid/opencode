import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// The host's runtime JSX transformer excludes node_modules; publish a precompiled companion.
const result = await Bun.build({
  entrypoints: [new URL("../tui.tsx", import.meta.url).pathname],
  outdir: new URL("..", import.meta.url).pathname,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
})
if (!result.success) throw new AggregateError(result.logs, "Could not compile the permissions TUI")
