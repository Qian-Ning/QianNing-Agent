# ADR 0323: Add HappyCoding as a Named Endpoint Preset

- Status: Accepted
- Date: 2026-10-10
- Deciders: QianNing Agent core
- Related: ADR 0116 (fixed provider preset), ADR 0155 (named endpoint presets)

## Context

`happycoding.xyz` is an OpenAI-compatible relay reached directly by a user. An
unauthenticated probe of `https://happycoding.xyz/v1/models` answers `401` with an
OpenAI-shaped JSON error (`{"error":{"message":"Invalid token …","type":"new_api_error"}}`),
so the API root is `/v1` and the service speaks the shape the existing
OpenAI-compatible path already sends. Configuring it today means pasting a base
URL into the custom-endpoint form, which loses the row's identity wherever the app
reasons about a provider: the add-provider Service picker cannot offer it, and no
preset name appears where a user looks for one.

The service is **not** a models.dev vendor — the bundled snapshot has no record for
it — so it cannot join the models.dev-backed named-service path, which persists a
catalog `vendorKey` and reads the published endpoint from that record.

## Decision

Add one row to `NAMED_ENDPOINT_PRESETS` (`packages/shared/src/provider-presets.ts`):

```text
id:        happycoding
vendorKey: happycoding
name:      HappyCoding
baseUrl:   https://happycoding.xyz/v1
apiStyle:  chat_completions
```

This adds no API-style value, no transport, and no new protocol profile. The row
reuses `chat_completions`, so the Rust `apiStyles` allowlist, model discovery
(`/models`), and the request path are unchanged. `service-catalog.ts` derives the
add-provider Service options from this table, so the picker, its search (label,
name, id, vendor key, aliases, base URL, host), and `service-catalog.test.mjs`
follow from the row itself rather than from a second registration site.

`vendorKey` is the host rather than a catalog key, because nothing resolves it
against models.dev: limits, modalities, and thinking options stay generic, and the
model list comes from the endpoint's own discovery. The DeepSeek-family
reasoning-replay rule keys off `vendorKey`, URL, model id, and catalog family, so a
relay serving DeepSeek ids receives the non-empty replay it requires (ADR 0256,
#296) with no relay-specific code.

Because this is the first named preset that is not a models.dev vendor, both
provider specs now say so where they describe the preset list: the provider-types
section of the model system spec, and the named-endpoint section of the config
schema.

## Consequences

- The relay is addable from the Service picker in one step. Name and endpoint are
  fixed, the API key is the only editable connection field, and save-time
  normalization keeps stale or hand-built form state from overriding them
  (ADR 0116's rule).
- Preset matching is URL-first, so an existing custom row that already points at
  this host begins matching the preset: it gains a stable identity and display
  name, and its display name stays editable in Advanced. No migration is needed,
  and stored rows keep their own headers and auth kind.
- The preset list is no longer strictly models.dev-backed. A future relay joins by
  adding a row, and the specs record exactly what is given up (catalog-recorded
  limits, modalities, and thinking options) rather than implying a record exists.
