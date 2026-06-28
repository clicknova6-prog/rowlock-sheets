# Rowlock Sheets

A production-oriented spreadsheet SaaS built with Next.js App Router, React, TypeScript, Tailwind CSS, Prisma, MySQL, custom role permissions, row ownership, validation rules, advanced conditional rules, formulas, audit history, and a dark/light theme.

## What Is Included

- Fixed spreadsheet grid: columns A-Z and rows 1-1000
- Admin/member roles with signed httpOnly cookie sessions
- Firebase Email/password authentication with Firestore-backed user profiles
- Column permissions controlled by admin
- Member row ownership and admin row unlock
- Allowed-value validation per column
- Multi-condition count-limit rule engine
- Formula support through HyperFormula, including `SUM` and arithmetic
- Firestore realtime change events on Firebase App Hosting, plus Socket.io live sync for custom-server deployments
- Admin spreadsheet formatting: range/row fills, text color, bold/italic/underline, alignment, clear formatting, and alternating row colors
- Admin dashboard for permissions, validation rules, conditional rules, row ownership, and audit history
- Prisma MySQL schema, migration, and seed data
- Vitest coverage for critical business rules

## Folder Structure

```txt
apphosting.yaml               Firebase App Hosting runtime config
prisma/
  migrations/                 MySQL migration for production deployment
  schema.prisma               Prisma schema
  seed.ts                     Demo seed data
server.ts                     Custom Next.js + Socket.io server entry
src/
  app/                        Next.js App Router pages, actions, and API routes
  components/                 App shell, admin dashboard, spreadsheet, theme UI
  hooks/                      Client hooks, including Socket.io sheet sync
  generated/prisma/           Generated Prisma client, recreated by prisma generate
  lib/
    auth/                     Session auth helpers
    sheet/                    Permission, validation, rule, formula, and snapshot logic
tests/                        Vitest business-rule tests
```

## Environment Variables

Create `.env` from `.env.example`.

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/DATABASE"
AUTH_SECRET="replace-with-at-least-32-random-characters"
NEXT_PUBLIC_APP_URL="https://your-domain.com"
DB_CONNECTION_LIMIT="5"
SOCKET_CORS_ORIGIN="https://your-domain.com"
NEXT_PUBLIC_ENABLE_SOCKET_SYNC="true"
NEXT_PUBLIC_ENABLE_FIRESTORE_SYNC="true"
```

`AUTH_SECRET` signs session cookies. Change it before production.
`DB_CONNECTION_LIMIT` should stay above 1 because sheet saves and snapshots use multiple database operations.
`SOCKET_CORS_ORIGIN` is optional for same-origin hosting, but set it to your production domain if Hostinger serves the app behind a domain/proxy that requires explicit Socket.io CORS.
`NEXT_PUBLIC_ENABLE_SOCKET_SYNC` should stay `true` for local/custom-server deployments and `false` for Firebase App Hosting, where cell edits save through the REST autosave endpoint.
`NEXT_PUBLIC_ENABLE_FIRESTORE_SYNC` should stay `true` on Firebase App Hosting so other open browsers receive realtime change events after MySQL saves.

## Local Development

To preview the spreadsheet without local MySQL or authentication, keep this in `.env`:

```env
SKIP_AUTH="true"
```

Then run:

```bash
npm run dev
```

Open `http://localhost:3000`. `npm run dev` starts the custom `server.ts` entry so Socket.io is mounted at `/socket.io`; do not use plain `next dev` for live sync testing. Demo edits stay in browser memory and do not touch a database.

When you are ready to use real auth and MySQL, set `SKIP_AUTH="false"` and run the database setup commands below.

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run seed
npm run dev
```

To run on a different local port:

```bash
npm run dev -- --port 3001
```

With Firebase Auth enabled, create users in Firebase Authentication or sign in with existing Firebase users. Set `FIREBASE_ADMIN_EMAILS` before a user's first sign-in to make that user an admin profile in Firestore.

The old Prisma seed passwords are no longer used by the login page.

Quality checks:

```bash
npm run lint
npm run typecheck
npm run test
```

## Firebase Setup

This project is connected to Firebase project `jobsheet-291c1` / project number `1077235869527`.

Firebase Web App:

- Display name: `rowlock-sheets-web`
- App ID: `1:1077235869527:web:c8c6654d135d55c2df8012`

Email/password Authentication has been enabled through Firebase CLI.

Firestore user profiles are stored in:

```txt
users/{firebaseAuthUid}
```

Each user profile contains:

```json
{
  "email": "user@example.com",
  "name": "User Name",
  "role": "ADMIN"
}
```

Firestore spreadsheet realtime events are stored in:

```txt
sheetRealtime/{sheetId}/events/{eventId}
```

These event documents are a lightweight notification layer only. The actual spreadsheet source of truth remains Cloud SQL/MySQL through Prisma.

Set `FIREBASE_ADMIN_EMAILS` to a comma-separated list of emails that should become admins the first time they sign in. It is currently set to `clicknova6@gmail.com` in `apphosting.yaml`. Existing Firestore user documents keep their saved role.

Cloud Firestore is enabled and the default Standard database has been created in `nam5`.

To redeploy Firestore rules:

```bash
npx -y firebase-tools@latest deploy --only firestore --project jobsheet-291c1
```

## Firebase App Hosting Deployment

Firebase is the chosen deployment target. The current Firebase phase uses Firebase Authentication, Firestore user profiles/realtime events, and Cloud SQL MySQL for durable spreadsheet data.

### App Hosting Runtime Shape

Firebase App Hosting uses the framework adapter, so it does not rely on Socket.io. `apphosting.yaml` sets `NEXT_PUBLIC_ENABLE_SOCKET_SYNC=false`; hosted cell edits save through `/api/cells` autosave, then Firestore broadcasts compact realtime events to other open browsers.

`apphosting.yaml` currently keeps `maxInstances: 1` to control Cloud SQL cost and connection pressure while usage is being validated. You can raise it later after checking database connections and write behavior under real employee traffic.

You can set `minInstances: 1` later for fewer cold starts. `minInstances: 0` keeps cost lower.

### Firebase Setup

1. Create a Firebase project and connect this repository to Firebase App Hosting.
2. Use the existing App Hosting backend:
   - Backend ID: `rowlock-sheets`
   - Region: `us-central1`
   - URL: `https://rowlock-sheets--jobsheet-291c1.us-central1.hosted.app`
3. Add App Hosting secrets:
   - `AUTH_SECRET`
   - `DATABASE_URL` while spreadsheet data is still in Prisma/MySQL
4. Replace `FIREBASE_ADMIN_EMAILS` in `apphosting.yaml` if you want different admin accounts.
5. Deploy from the Firebase App Hosting GitHub integration.

For Cloud SQL Unix socket connections, format `DATABASE_URL` like this:

```env
DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/DATABASE?socketPath=%2Fcloudsql%2FPROJECT_ID%3AREGION%3AINSTANCE_NAME"
```

The app also supports a normal TCP MySQL URL:

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/DATABASE"
```

After the first successful Firebase build, run the Prisma migrations against the production database:

```bash
npm run prisma:deploy
```

Then seed only if this is a brand-new empty database:

```bash
npm run seed
```

`npm run build` already runs `prisma generate`, `next build`, and the custom server build. On Firebase App Hosting, the framework adapter serves the Next.js app and the spreadsheet uses REST autosave plus Firestore realtime notifications. On custom-server hosts, `npm run start` runs the generated root `server.js`, which mounts Socket.io at `/socket.io`.

## Hostinger Business Deployment

This is the legacy shared-hosting path. For heavy live spreadsheet use, prefer Firebase App Hosting or a VPS.

Use a Hostinger Business plan with Node.js and MySQL enabled.

1. Create a MySQL database in Hostinger.
2. Set environment variables in the Node.js app panel:
   - `DATABASE_URL`
   - `AUTH_SECRET`
   - `NEXT_PUBLIC_APP_URL`
   - `DB_CONNECTION_LIMIT=5`
   - `NODE_ENV=production`
3. Deploy by GitHub import or ZIP upload.
4. Set the install command:

```bash
npm ci
```

5. Set the build command:

```bash
npm run prisma:deploy && npm run build
```

6. Set the start command:

```bash
npm run start
```

7. In Hostinger Node.js settings, set the startup file to:

```txt
server.js
```

`npm run build` emits `.server/server.js` and a root `server.js` wrapper. Hostinger should run the root `server.js`, which starts the custom Next.js server and mounts Socket.io at `/socket.io`.

8. If this is the first deployment, run once from Hostinger terminal:

```bash
npm run seed
```

After changing environment variables, restart the Node.js app from Hostinger. The app rebuilds cleanly because `npm run build` runs `prisma generate`, `next build`, and the custom server TypeScript build.

### WebSocket Notes

- Local/custom-server deployments can use one persistent Socket.io WebSocket connection per browser tab instead of repeated REST polling.
- Firebase App Hosting sets `NEXT_PUBLIC_ENABLE_SOCKET_SYNC=false`, so cell value changes use `/api/cells` REST autosave and Firestore event listeners.
- Each sheet joins a private room named `sheet:{sheetId}`.
- The client forces the `websocket` transport and does not use Socket.io HTTP long-polling fallback.
- Large paste operations are saved in batches. Socket.io uses 50-cell chunks; hosted REST autosave uses larger API batches.
- Pasted batches above 100 cells keep a summary audit entry instead of one audit row per cell, which keeps large imports practical on shared hosting.
- Single-process Socket.io is intentional for local/custom-server deployments. Firebase App Hosting uses Firestore events instead of Socket.io for cross-browser updates.
- REST endpoints handle initial page load, Firebase-hosted autosave, admin formatting, and cell history.

## Database Schema Overview

- `User`: email, password hash, admin/member role
- `Sheet`: spreadsheet workspace
- `SheetRow`: row metadata and last editor
- `Cell`: raw values, formulas, computed values, transient `lockedBy` edit lock
- `CellFormat`: saved cell and row-range formatting
- `SheetViewSetting`: alternating row color settings
- `ColumnPermission`: admin-only vs member-editable columns
- `RowOwnership`: current owner for member-claimed rows
- `ValidationRule`: allowed values per column
- `ConditionalRule`: enabled count-limit rules
- `RuleCondition`: column conditions for advanced rules
- `AuditLog`: security and change history

## Assumptions And Limits

- The UI prioritizes desktop spreadsheet workflows, with responsive admin tools where practical.
- Bulk paste is treated as grid input, but single-cell edits are the primary save path.
- Formula functions are limited to what HyperFormula supports under the GPL license key setting used here.
- Production requires MySQL; tests cover the pure rule engine and do not require a database.
