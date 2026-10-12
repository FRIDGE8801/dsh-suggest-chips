# `connection.rpc.handle()` is unusable from any plugin: the host registry resolves `webServer` on its own fiber, which never injects it

## Summary

`ctx.connection.rpc.handle(channel, handler)` throws

```
Error: cannot get property "webServer" without inject
```

for **every** calling plugin, regardless of that plugin's own `inject` list.

`HostConnectionService` resolves the `webServer` service on **its own plugin
fiber** (`this.ctx`) rather than on the calling context, and that fiber injects
neither `webServer` nor anything that provides it. Because the throw happens
inside the caller's `apply()` body, Cordis rolls back everything the plugin
registered earlier in that fiber — typically including the `session/event`
listener wired just above the call. The plugin then appears to load normally
while doing nothing at all, which makes this very hard to diagnose from the
outside.

## Affected version

- `dsh` `0.2.0-rc.2` (desktop app build, also present on `main` at time of writing)
- Package: `@deepseek-ai/dsh-client-connection`

## Reproduction

Any plugin whose `apply()` calls `ctx.connection.rpc.handle(...)`:

```ts
export const inject = ['connection']   // adding 'webServer' does NOT help

export function apply(ctx: Context): void {
  ctx.on('session/event', () => { /* ... */ })   // registered first
  const remove = ctx.connection.rpc.handle('/my-channel', async (endpoint, payload) => {
    return { ok: true, value: null }
  })
  // never reached
}
```

Observed: `rpc.handle` never returns; the `session/event` listener registered on
the previous line is silently rolled back with the failed fiber.

Adding `webServer` to the plugin's `inject` changes nothing, which is the key
tell — the failing read is not on the plugin's context.

## Analysis

`packages/client/connection/src/rpc-host.ts:86-93`:

```ts
get rpc(): HostConnectionRpc {
  const owner = this.ctx                    // <-- the CONNECTION service's fiber
  return {
    handle: (channel, handler) => this.register(owner, channel, handler),
    intercept: (channel, matches, handler) =>
      this.registerInterceptor(owner, channel, matches, handler),
  }
}
```

`packages/client/connection/src/rpc-host.ts:192`:

```ts
      () => owner.webServer.register(route),
```

`packages/client/connection/src/index.ts:89`:

```ts
export const inject = ['credentials']
```

and its profile row (`packages/bundle/web-app/cordis.patch.yml:216-218`):

```yaml
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [webRuntime]
```

So the connection fiber's effective inject set is `['credentials', 'webRuntime']`.
`webServer` is provided by a **different** row
(`packages/bundle/web-app/cordis.patch.yml:169-171`,
`@deepseek-ai/dsh-host-webserver`), and is never injected into `connection`.

Cordis gates service reads on the reading fiber's `inject` list
(`@deepseek-ai/cordis`, `ReflectService.handler.get`):

```js
const error = new Error(`cannot get property "${prop}" without inject`)
```

Because `owner === this.ctx` is the connection fiber, `owner.webServer` throws —
and no declaration by the caller can satisfy a read that is not made on the
caller's context.

Note the sibling surface `connection.fetch` has the identical shape
(`rpc-host.ts:96-99`, `const owner = this.ctx`), but its `registerFetchRoute`
only writes to `this.fetchRoutes` and reads no `webServer`, so it works. That
asymmetry is what makes `fetch` usable and `rpc.handle` dead.

## Impact

`connection.rpc.handle` — and `connection.rpc.intercept` — are currently
unusable by any plugin. Verified as the sole cause of a real report: a plugin
that installed and loaded cleanly (its client bundle served `200`, its graph row
was present and correct) never produced output, because its host half threw at
the registration call and lost its session listener. There was no error visible
anywhere: the desktop app discards stdout, so `ctx.logger` output is not a
usable diagnostic channel, and the throw is contained inside the failed fiber.

## Expected behavior

Either of these would make the documented surface work:

1. **Add `webServer` to the package's inject list** (`index.ts`) or to its
   profile row, since `register()` genuinely needs it.
2. Better: **resolve `webServer` on the calling context**, not on `this.ctx`.
   The channel registration belongs to the caller's lifetime — that is already
   expressed by passing `owner` into `register()`, and the caller can (and
   should) be the one to declare the dependency. Concretely, `owner` should be
   the `ctx` the plugin read `connection` from, so
   `owner.effect(() => owner.webServer.register(route))` both scopes the
   disposer to the caller and reads the service where it is actually injected.

Option 2 also fixes `intercept`, and keeps the registration's lifetime aligned
with the calling plugin rather than with the connection service.

## Workaround

Use `ctx.connection.fetch.register(...)`, which is unaffected and is what
`@deepseek-ai/dsh-client-file-upload` already uses
(`packages/client/file-upload/src/index.ts`):

```ts
ctx.effect(
  () => ctx.connection.fetch.register({
    path: '/api/my-plugin',        // must be under /api: assertFetchRoute enforces it
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => Response.json({ value: null }),
  }),
  'my-plugin: browser route',
)
```

The path must sit under `/api` (`assertFetchRoute` calls
`endpointFromPath("/api", route.path)` and throws otherwise), and dispatch is by
exact pathname (`createSharedFetchHandler` looks routes up via
`new URL(request.url).pathname`). The browser then calls it with a plain
`fetch`, so no `dsh-client-*` import is needed on the client side either.

## Diagnostic note

A useful signal while investigating: the failing route answers `405` from the
SPA fallback (`@deepseek-ai/dsh-host-frontend-static` returns `405` for any
non-GET request that reaches it), whereas a correctly registered route answers
`401`/`200` like the known-good `/api` gateway route. `405` therefore means "not
registered", not "registered" — worth stating because it reads like progress.