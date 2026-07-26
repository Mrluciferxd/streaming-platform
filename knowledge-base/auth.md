# Auth

## What this subsystem does

Accounts, sessions and the operator role gate. Everything personalised —
watchlist, Continue Watching across devices, the admin panel — depends on it.

## How it is structured

```
src/lib/auth/
  password.ts     scrypt hashing, constant-time verify, timing-equalising fake
  session.ts      Create/read/destroy sessions, expiry purge, client IP
  require-role.ts Operator gate for pages and route handlers
src/app/api/auth/{register,login}/route.ts   login route also handles DELETE (logout)
src/app/(auth)/account/                      Combined sign-in / register form
```

Tables: `users`, `sessions` (see [database.md](database.md)).

## Conventions and rules

- Password minimum is length only (10 chars), no composition rules — NIST
  dropped those because they push people toward `Password1!`.
- Sessions are opaque random tokens; only the SHA-256 is stored.
- `getSessionUser()` is safe to call from any server component.
- The admin gate returns **404**, never 403.

## Known gotchas

**Login must burn equivalent work when no account matches.** Without
`fakeVerify()`, a missing account returns in microseconds and a real one takes
~100ms of scrypt. That gap is measurable over the network and enumerates which
addresses are registered — on a service holding viewing history, that is a
privacy leak in its own right. Registration returns a generic
`registration_failed` for the same reason.

**404, not 403, on the admin surface.** A 403 confirms the route exists and
turns the panel into a discoverable target. `requireAdminApi()` returns a
discriminated union, so a handler that forgets to check does not compile.

**Gate every admin page, not just the layout.** Next reuses a layout across
client-side navigation within a segment, so a gate that lives only there is not
re-evaluated per request.

**`sameSite: 'lax'`, not `'strict'`.** Strict withholds the cookie on the first
request after following an external link, so a viewer arriving from search would
land signed out and sign back in on the next click.

**Logout deletes the row.** Clearing the cookie alone leaves a copied token
valid for its full 30 days.

**Soft-deleted users cannot authenticate.** Their rows survive for referential
integrity, and `getSessionUser()` checks `deleted_at`.

**scrypt needs `maxmem` raised.** Node's default is 32 MB and N=32768 exceeds
it; without raising it the call throws rather than quietly producing a weaker
hash.

**Email verification is not implemented.** `users.email_verified` is always
false — it needs a transactional mail provider.

## How it is tested

`scripts/smoke.ts` covers the full session leg against a deployment:
registration, duplicate email → 409, missing consent → 400, wrong password and
unknown account both → 401 with identical bodies, session-gated endpoints → 401
when anonymous, sign-out revoking the session, and signing back in with state
intact. No unit tests for password hashing itself.

## Related

- [admin.md](admin.md) — what the role gate protects
- [database.md](database.md) — `users`, `sessions`
- [decisions.md](decisions.md) — scrypt and server-side sessions
