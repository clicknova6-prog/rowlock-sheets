# Firestore Rules Analysis

Date: 2026-06-28

## Codebase Findings

- Firebase Auth signs users in with email/password.
- Server session creation uses Firebase Admin Auth and Firestore `users/{uid}` profiles.
- Client Firestore reads:
  - `users/{uid}` through Firebase/Auth-related profile behavior.
  - `sheetRealtime/{sheetId}/events` with:
    - `where("createdAt", ">", subscribedAfter)`
    - `orderBy("createdAt", "asc")`
    - `limit(100)`
  - Admin-only `sheetPresence/{sheetId}/users` with:
    - `orderBy("updatedAt", "desc")`
    - `limit(120)`
- Server Firestore writes:
  - `users/{uid}` through Admin SDK only.
  - `sheetRealtime/{sheetId}/events/{eventId}` through Admin SDK only after MySQL saves.
- Client Firestore writes:
  - `sheetPresence/{sheetId}/users/{uid}` for the signed-in user's own heartbeat only.
- Spreadsheet cell data, formatting, history, and row ownership remain in Cloud SQL/MySQL through Prisma.

## Security Model

- Default deny remains in place for unmatched paths.
- Client writes to `users`, sheet events, and sheet data are denied.
- Users can read only their own user profile; admins can read all profiles.
- Any authenticated app user can list `sheetRealtime` events. This matches the current single-shared-sheet app model, where authenticated users can open the sheet. Future workbook-level sharing should add per-sheet ACL checks to Firestore rules.
- Direct event document gets are schema-checked. Collection-list reads are authenticated-only because Firestore rules cannot use document schema validation as a query filter for this listener.
- Presence documents contain only public display data: uid, display name, role, UI color, and timestamp. They do not contain email addresses.
- Presence writes must match the signed-in user's own document id and must copy name/role from the locked-down `users/{uid}` profile.
- Presence list reads are admin-only so members cannot see a roster of other active members.

## Attack Review

- Public list exploit: blocked by `signedIn()`.
- Public presence roster list exploit: blocked by `isAdmin()`.
- Unauthorized writes to user profiles and realtime events: blocked because client creates/updates/deletes are false on those paths.
- Unauthorized presence write: blocked because `request.auth.uid` must equal the presence document id.
- Presence spoofing: blocked because `name` and `role` must match the server-managed `users/{uid}` document.
- Presence timestamp manipulation: blocked because writes require `updatedAt == request.time`, matching `serverTimestamp()`.
- Privilege escalation: blocked because clients cannot write `users/{uid}` or roles.
- Schema pollution by client: blocked because client writes are false.
- Presence schema pollution: blocked by `hasOnly` and type/length/color validation.
- Resource exhaustion by client write: blocked because client writes are false; read rules still limit event field sizes where possible.
- Presence resource exhaustion: strings are length-limited; each user writes to their own presence document path.
- PII leak in users: profile reads are owner-only or admin-only.
- Query mismatch: event listener uses `list`, which is allowed for signed-in users. Direct `get` remains schema-checked.
- Presence query mismatch: admin listener uses `list`, `orderBy(updatedAt desc)`, and `limit(120)`, which the admin-only list rule allows.
- Mixed content leak: `users` documents contain PII and are not generally readable.
