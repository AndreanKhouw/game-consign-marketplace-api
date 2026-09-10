# ADR-001: Opaque Session and Client Storage

Status: **Accepted**

## Context

The API is called by untrusted SPA and mobile clients. It requires short-lived
access, refresh rotation, reuse detection, immediate logout, and mass revocation.
No application secret can be hidden in a first-party client.

## Options considered

1. Self-contained JWT access and refresh tokens.
2. JWT access plus opaque refresh token.
3. Opaque access and refresh tokens backed by server-side session state.

## Decision

Use opaque random 256-bit tokens. Return the access token in the response and
keep it in memory/OS-protected storage. Send the refresh token in an `HttpOnly`,
`Secure`, `SameSite=Lax` cookie scoped to `/v1/auth`.

Persist only token hashes. Rotate refresh tokens transactionally, track their
successor, and revoke the entire family on reuse. Logout, password changes, user
disablement, and privilege changes revoke server-side families.

## Consequences

- Immediate revocation and reuse detection are straightforward and testable.
- JWT algorithm-confusion and signing-key rotation concerns do not apply.
- Every authenticated request needs a shared session lookup, increasing Redis/DB
  dependency and latency.
- Access tokens are exposed to active XSS while present in memory, but refresh
  tokens cannot be read by browser JavaScript.
- Refresh/logout retain CSRF and forced-logout risks; SameSite, strict Origin
  validation, and same-site deployment mitigate them.
- Strict concurrent refresh detection can revoke legitimate sessions, so clients
  must perform single-flight refresh.
