# Storage and Delivery

## What this subsystem does

Holds source uploads and finished HLS packages, and gets segments to browsers
without routing them through the application. This is the subsystem the business
model rests on: video is ~1 GB per viewing hour, so at 10k DAU the choice made
here is worth more than every other optimisation combined.

## How it is structured

```
src/lib/video/
  types.ts     VideoProvider interface, ABR ladder, path layout, part sizing
  index.ts     getVideoProvider() — the only public entry point
  r2.ts        Cloudflare R2 (S3-compatible)
  bunny.ts     Bunny Stream (managed; TUS instead of multipart)
  local.ts     Filesystem, development only
  token.ts     Playback token issue/verify
infra/cloudflare/playback-gate.worker.js   Edge enforcement
```

`paths` in `types.ts` is the canonical object layout (`v/<id>/master.m3u8`,
`v/<id>/720p/seg_00001.m4s`, …). Those strings end up in CDN cache keys, so they
are stable by contract.

## Conventions and rules

- **Nothing outside `src/lib/video/` imports `./r2`, `./bunny` or `./local`.**
  Import `getVideoProvider()`.
- **The database stores bucket-relative paths, never URLs.** `provider.publicUrl()`
  resolves them in the query layer. This is what makes a provider swap a config
  change instead of a data migration — and it has already been broken once, when
  raw paths reached `next/image` and every poster threw.
- **Bytes never transit the app server.** Uploads go browser → bucket with
  presigned URLs; playback goes browser ← CDN ← bucket.
- Segments and playlists are immutable, served with a one-year `Cache-Control`.
  A re-encode writes to a new video id rather than overwriting.
- Content types matter: `.m3u8` served with the wrong type makes Safari refuse
  the stream outright, and a missing type on `.vtt` breaks scrub previews
  silently.

## Known gotchas

**The cookie is the whole design.** Playback authorisation is an HMAC in a
cookie scoped to `/v/`, verified by an edge Worker, with the cache key left as
the URL alone. Signing individual segment URLs would give every viewer a unique
cache key — cache hit ratio collapses, every segment becomes an origin read, and
the delivery bill goes from tens of dollars to thousands. Never move the token
into a query string, never add the cookie to the cache key, never `Vary` on
`Cookie` or `Authorization`.

**The CDN hostname must be a subdomain of the app domain.** `example.com` +
`cdn.example.com`. Otherwise the browser will not attach the playback cookie and
the edge gate 403s everything. Decide this when buying the domain; retrofitting
means re-cutting every published URL.

**Rotate the Worker secret and the app secret together.** The Worker caches the
imported HMAC key per secret value, not in a single slot — a bare memo would pin
the first secret an isolate ever saw and keep honouring old tokens through a
rotation, which is exactly what rotating is meant to stop.

**R2 multipart, not TUS.** Plan §5.1 specifies TUS; Bunny speaks it natively and
R2 does not. The R2 path uses S3 multipart with 8 MB parts — sized for a
connection that drops every few minutes, not for peak throughput. Resume asks
the *bucket* which parts it holds rather than trusting client state, so it
survives a crash, a reload, or a different machine.

**Presigned URLs expire in an hour.** A 20 GB upload outlives that, so the admin
uploader treats a 403 on a part as an expired signature and re-signs rather than
failing the upload.

**Cloudflare's old Section 2.8 is gone.** Serving video through their CDN is
explicitly permitted when the content is hosted in a Cloudflare service — R2
qualifies. Video served from an origin outside Cloudflare is still restricted,
so the bucket must remain the origin.

**`VIDEO_PROVIDER=local` is not a deployment target.** It serves every byte as a
deployment asset at platform bandwidth rates — the exact cost profile plan §0
exists to avoid. Production refuses it unless `ALLOW_LOCAL_MEDIA=1` is set
explicitly, and warns on boot when it is.

## How it is tested

`npm run check:r2` exercises the full `VideoProvider` contract against real
credentials — multipart create, presign, direct PUT, list parts, complete from
the *listed* parts (the resume path), byte-identical download, directory upload
with content-type checks, abort-releases-parts, prefix delete. It skips with the
missing variables named when credentials are absent, which is the current state
(ISSUE-001).

`npm run check:token` verifies that the app's issuer and the Worker's verifier
agree. They live in different files and different runtimes; a format drift 403s
every segment platform-wide.

## Related

- [architecture.md](architecture.md) — where this sits in the system
- [video-pipeline.md](video-pipeline.md) — what produces the packages
- [decisions.md](decisions.md) — the cookie decision and its consequences
