import { Integration, Model, Provider, type Plugin } from "@opencode/plugin/effect"
import { Effect, Schema, Struct } from "effect"
import { type ConnectionInput, type ConnectionRole, type ConnectionSettings } from "./contract.js"
import type { Options } from "./review.js"

const SavedConnection = Schema.Struct({ url: Schema.String, providerID: Schema.String, authenticated: Schema.Boolean })
type SavedConnection = typeof SavedConnection.Type

/** Connection overrides are server-wide; only non-secret metadata enters plugin storage. */
export const connections = Effect.fn(function* (
  ctx: Plugin.Context,
  options: typeof Options.Type,
  read: Effect.Effect<typeof Options.Type, unknown> = Effect.succeed(options),
) {
  const configured = { value: options }
  const roles = (): ConnectionRole[] => ["classifier", ...(configured.value.fallback ? ["fallback" as const] : [])]
  const records = new Map<ConnectionRole, SavedConnection>()
  const integrations = new Map<string, ConnectionRole>()
  const original = (role: ConnectionRole) =>
    role === "classifier" ? configured.value.model : configured.value.fallback!.model
  const title = (role: ConnectionRole) =>
    role === "classifier" ? "Primary permission reviewer" : "Permission chat fallback"

  yield* ctx.integration.transform((editor) => {
    integrations.forEach((role, id) => {
      editor.update(id, (integration) => {
        integration.name = title(role)
      })
      editor.method.update({ integrationID: id, method: { type: "key", label: `${title(role)} API key` } })
    })
  })
  yield* ctx.provider.transform((editor) => {
    records.forEach((record, role) => {
      const ref = original(role)
      const source = editor.get(ref.providerID)
      const model = source?.models.get(ref.id)
      if (!source || !model) return
      const id = Provider.ID.make(record.providerID)
      editor.add({
        info: {
          id,
          name: title(role),
          integrationID: Integration.ID.make(record.providerID),
          activation: record.authenticated ? "auto" : "enabled",
          package: model.package ?? source.provider.package,
        },
        models: [
          {
            ...model,
            providerID: id,
            package: model.package ?? source.provider.package,
            // Never carry the source provider's credentials or headers to a custom endpoint.
            headers: {},
            settings: { baseURL: record.url, ...(record.authenticated ? {} : { apiKey: false }) },
            variants: model.variants.map((variant) => ({
              ...Struct.omit(variant, ["settings", "headers"]),
              headers: {},
            })),
          },
        ],
      })
    })
  })

  const refresh = Effect.fn(function* (snapshot?: typeof Options.Type) {
    const next = snapshot ?? (yield* read)
    const changed =
      JSON.stringify([configured.value.model, configured.value.fallback?.model]) !==
      JSON.stringify([next.model, next.fallback?.model])
    configured.value = next
    const saved = yield* Effect.forEach(roles(), (role) =>
      ctx.storage.get(`connection/${role}`).pipe(
        Effect.flatMap((value) =>
          value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(SavedConnection)(value),
        ),
        Effect.map((record) => ({ role, record })),
      ),
    )
    if (!changed && saved.every(({ role, record }) => JSON.stringify(records.get(role)) === JSON.stringify(record)))
      return
    records.clear()
    saved.forEach(({ role, record }) => {
      if (!record) {
        records.delete(role)
        return
      }
      records.set(role, record)
      if (record.authenticated) integrations.set(record.providerID, role)
    })
    yield* ctx.integration.reload()
    yield* ctx.provider.reload()
  })
  yield* refresh().pipe(Effect.orDie)

  const model = Effect.fn(function* (role: ConnectionRole, snapshot?: typeof Options.Type) {
    yield* refresh(snapshot)
    const ref = original(role)
    const record = records.get(role)
    return record ? Model.Ref.make({ ...ref, providerID: Provider.ID.make(record.providerID) }) : ref
  })
  const list = Effect.fn(function* () {
    yield* refresh()
    return yield* Effect.forEach(roles(), (role) =>
      Effect.gen(function* () {
        const ref = original(role)
        const record = records.get(role)
        if (record)
          return {
            role,
            model: ref,
            url: record.url,
            custom: true,
            authenticated: record.authenticated,
          } satisfies ConnectionSettings
        const provider = yield* ctx.provider.get({ providerID: ref.providerID }).pipe(Effect.option)
        const url = provider._tag === "Some" ? provider.value.data.settings?.baseURL : undefined
        return {
          role,
          model: ref,
          ...(typeof url === "string" ? { url } : {}),
          custom: false,
          authenticated: false,
        } satisfies ConnectionSettings
      }),
    )
  })
  const set = Effect.fn(function* (input: ConnectionInput) {
    yield* refresh()
    if (!roles().includes(input.role)) return yield* Effect.fail(new Error("Configure a fallback model first"))
    if (input.url === undefined) {
      yield* ctx.storage.remove(`connection/${input.role}`)
      return yield* list()
    }
    const url = endpoint(input.url)
    yield* refresh()
    const previous = records.get(input.role)
    // Keeping a key is explicit and applies only to its existing endpoint.
    const keep = input.apiKey === undefined && previous?.url === url
    const key = input.apiKey?.trim()
    const record = keep
      ? previous
      : { url, providerID: `permission-review-${input.role}-${crypto.randomUUID()}`, authenticated: !!key }
    if (key) {
      integrations.set(record.providerID, input.role)
      yield* ctx.integration.reload()
      yield* ctx.integration.connect.key({ integrationID: Integration.ID.make(record.providerID), key })
    }
    yield* ctx.storage.set(`connection/${input.role}`, record)
    return yield* list()
  })
  return { model, list, set }
})

export function endpoint(value: string) {
  if (!URL.canParse(value.trim())) throw new Error("Enter an HTTP or HTTPS base URL, including /v1 when required")
  const url = new URL(value.trim())
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP or HTTPS base URL without embedded credentials, query or fragment")
  return url.href.replace(/\/+$/, "")
}
