import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { ApprovalPrompt } from "./prompt"
import { authenticate } from "./native"
import Sudo from "./rpc"
import type { Request } from "./rpc"

export default Plugin.define({
  id: "experimental.sudo",
  setup(ctx) {
    const rpc = ctx.client.rpc(Sudo)
    const [pending, setPending] = createSignal<readonly Request[]>([])
    const active = { id: "", close: () => {}, invalidate: () => {} }
    const revision = { value: 0 }
    const [available, setAvailable] = createSignal(ctx.renderer.controlState !== "explicit_suspended")
    const frame = () => setAvailable(ctx.renderer.controlState !== "explicit_suspended")
    ctx.renderer.on("frame", frame)
    onCleanup(() => ctx.renderer.off("frame", frame))
    const controller = new AbortController()
    const sessionID = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const location = () => ctx.data.session.get(sessionID() ?? "")?.location ?? ctx.location
    const load = () => {
      const id = sessionID()
      if (!id) return
      const current = ++revision.value
      void rpc.list({ sessionID: id }, { location: location(), signal: controller.signal }).then(
        (requests) => {
          if (current === revision.value && sessionID() === id && !controller.signal.aborted) setPending(requests)
        },
        () => undefined,
      )
    }
    onCleanup(
      rpc.events.on("requested", (event) => {
        if (event.data.sessionID !== sessionID()) return
        revision.value++
        setPending((current) => [...current.filter((request) => request.id !== event.data.id), event.data])
        void ctx.attention.notify({ title: "Sudo requested", message: `Review a root command on ${event.data.host}` })
      }),
    )
    onCleanup(
      rpc.events.on("closed", (event) => {
        revision.value++
        setPending((current) => current.filter((request) => request.id !== event.data.id))
        if (active.id === event.data.id) active.invalidate()
      }),
    )
    onCleanup(ctx.data.on("server.connected", load))
    createEffect(
      on(sessionID, () => {
        // Route changes may come from the server (for example session deletion), not a user dismissal.
        if (active.id) active.invalidate()
        setPending([])
        load()
      }),
    )
    createEffect(() => {
      const request = pending()[0]
      const mode = ctx.keymap.mode.current()
      const ready = available()
      if (ctx.renderer.controlState === "explicit_suspended") {
        setAvailable(false)
        return
      }
      if (!request || active.id || !ready || (mode !== "base" && mode !== "composer")) return
      active.id = request.id
      const options = { location: location(), signal: controller.signal }
      const state = { submitted: false }
      const handoff = new AbortController()
      const [closed, setClosed] = createSignal(false)
      const [error, setError] = createSignal("")
      active.close = () => ctx.ui.dialog.clear()
      active.invalidate = () => {
        handoff.abort()
        if (state.submitted) void rpc.cancel({ id: request.id }, options).catch(() => undefined)
        setClosed(true)
      }
      ctx.ui.dialog.show(
        () => (
          <ApprovalPrompt
            request={request}
            theme={ctx.theme}
            closed={closed()}
            error={error()}
            onCancel={() => ctx.ui.dialog.clear()}
            onSubmit={() => {
              if (state.submitted) return
              state.submitted = true
              setClosed(true)
              void authenticate(ctx.renderer, request, ctx.theme, handoff.signal).then(
                (released) => {
                  void rpc.cancel({ id: request.id }, options).catch(() => undefined)
                  if (released && active.id === request.id) ctx.ui.dialog.clear()
                },
                () => {
                  void rpc.cancel({ id: request.id }, options).catch(() => undefined)
                  setError(
                    "Cannot open native sudo. Use a local Linux x64 terminal and reinstall the plugin if its bundled helper is missing.",
                  )
                },
              )
            }}
          />
        ),
        () => {
          handoff.abort()
          void rpc.cancel({ id: request.id }, options).catch(() => undefined)
          // The host is still clearing its dialog stack here; opening the next prompt now would discard it.
          queueMicrotask(() => {
            if (active.id === request.id) active.id = ""
            if (!controller.signal.aborted) setPending((current) => current.filter((item) => item.id !== request.id))
          })
        },
      )
      ctx.ui.dialog.set({ size: "medium", centered: true })
    })
    onCleanup(() => {
      if (active.id) active.close()
      controller.abort()
    })
  },
})
