# Identity, Auth & Interfaces

Covers the identity model, the auth flows, the HTTP API (`apps/api`), and the Studio web app
(`apps/studio`). The data tables are in [`data-model.md`](./data-model.md).

## 6.1 Four distinct concepts: identity vs user vs person vs participant

These are routinely conflated; the code keeps them separate:

| Concept         | Table                       | Scope      | Meaning                                                                                                                                                                                    |
| --------------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Identity**    | `identities`                | **global** | One per chat-provider account, keyed by `(provider, providerUserId)` (e.g. Telegram user 12345). Optionally links to a `user`.                                                             |
| **User**        | `users`                     | **global** | A cross-provider account; multiple identities can point at one user. Global role `user` or `super_admin` (role changes blocked by a trigger).                                              |
| **Person**      | `people`                    | **family** | A node in a family tree (name, aliases, birth/death). May be an unresolved `isPlaceholder`.                                                                                                |
| **Participant** | derived via `family_access` | family     | A _Person_ who has actually sent ≥1 message in the conversation. Verified by the DB function `is_person_participant()`. Used to decide whether the Facilitator addresses someone directly. |

The link chain: a Telegram message → **Identity** → **`family_access`** (identity ↔ family, with a
claimed `personId` and a role) → **Person** → **Relationships**.

`family_access` carries the per-family `role` (`admin | member | viewer`), `status`
(`pending | active | revoked | suspended`), the claimed `personId`, and how access was `grantedBy`
(`system | admin | telegram_login | access_pass | chat_join | studio_link`).

## 6.2 Auth flows (`libs/auth`)

### Telegram Login Widget

`verifyTelegramLogin(data, botToken)` validates the widget callback: rejects payloads older than 24 h,
and verifies the HMAC-SHA256 (secret = `SHA-256(botToken)`) over the sorted fields. On success the api
creates/updates the user + identity and issues a JWT session.

### Access passes (`access-pass.ts`)

A short-lived, single-use token to bring a chat member into the Studio web app:

1. **Create** (`createAccessPass`) — triggered by `/sobremesa studio-link` in chat. A 32-byte random
   token is generated; only its **SHA-256 hash** is stored (`access_passes`), with `familyId`, `role`
   (derived from the user's chat-admin status), `provider/providerUserId`, `chatId`, expiry (default
   24 h), `status='pending'`. Existing pending passes for that user+family are expired first. The
   unhashed token is delivered to the user via DM as a link to the Studio.
2. **Validate / Claim / Redeem** — redeeming hashes the token, atomically flips
   `pending → processing` (single-use), links/creates the identity, grants `family_access`, marks
   `redeemed`, and returns a session JWT.

### Session

A JWT (`SessionPayload`: `userId`, `identityId`, `provider`, `providerUserId`, `displayName`, global
`role`, `iat`, `exp`) signed with `ACCESS_PASS_SECRET`. The Studio stores it in `localStorage`
(`sobremesa_auth_token`).

### Guards (Elysia middleware, `middleware/guards.ts`)

`requireAuth` (401 if no session), `requireSuperAdmin` (403 if not super-admin), and
`createFamilyMemberGuard(param, minimumRole?)` which checks family access and the role hierarchy
`viewer < member < admin`. These complement the database-level RLS described in
[`data-model.md` §2.9](./data-model.md#29-multi-family-isolation--row-level-security).

## 6.3 HTTP API (`apps/api`, Elysia, Bun)

Startup (`apps/api/src/main.ts`) validates env, creates the Supabase service-role client, installs the
JWT auth plugin, CORS, Swagger (`/swagger`), and mounts the route groups. Deployed to Fly.io
(`sobremesa-api`, :8080, force-HTTPS, scale-to-zero).

### Public

| Method | Path                | Purpose                                             |
| ------ | ------------------- | --------------------------------------------------- |
| GET    | `/health`           | health check                                        |
| GET    | `/api/public/stats` | aggregate counts: families, people, stories, events |

### Auth (`routes/auth.ts`)

| Method | Path                    | Auth | Purpose                                            |
| ------ | ----------------------- | ---- | -------------------------------------------------- |
| POST   | `/api/auth/telegram`    | no   | Telegram-login callback → session token + families |
| GET    | `/api/auth/pass/:token` | no   | redeem an access pass → session token              |
| GET    | `/api/auth/me`          | yes  | current user + family memberships                  |
| POST   | `/api/auth/logout`      | no   | clear session (client-side)                        |

### Family

| Method | Path                            | Auth | Purpose                                                             |
| ------ | ------------------------------- | ---- | ------------------------------------------------------------------- |
| GET    | `/api/family/summary`           | yes  | summary of the active family (first with a chat)                    |
| GET    | `/api/family/:familyId/summary` | yes  | people, relationships, places, events, stories, and question counts |
| POST   | `/api/narrative/generate`       | yes  | returns a placeholder response                                      |
| POST   | `/api/book/generate`            | yes  | returns a placeholder response                                      |

### Identity (`routes/identity.ts`)

| Method | Path                                     | Auth | Purpose                                      |
| ------ | ---------------------------------------- | ---- | -------------------------------------------- |
| GET    | `/api/family/:familyId/identity`         | yes  | current claim + auto-suggestion + top people |
| POST   | `/api/family/:familyId/identity/claim`   | yes  | claim a person as yourself (`{personId}`)    |
| DELETE | `/api/family/:familyId/identity/claim`   | yes  | unclaim                                      |
| GET    | `/api/family/:familyId/people`           | yes  | list/search people (≤50)                     |
| POST   | `/api/family/:familyId/people`           | yes  | self-register a new person                   |
| PATCH  | `/api/family/:familyId/people/:personId` | yes  | edit your claimed person                     |

### Admin (super-admin only)

| Method | Path                       | Purpose                              |
| ------ | -------------------------- | ------------------------------------ |
| GET    | `/api/admin/chats`         | list allow-listed chat ids           |
| POST   | `/api/admin/chats`         | authorise a chat (`{chatId, note?}`) |
| DELETE | `/api/admin/chats/:chatId` | remove from the allow-list           |

## 6.4 Studio web app (`apps/studio`, Solid.js + Vite)

A Solid.js SPA (`@solidjs/router`); auth state lives in `AuthContext` (`login`, `logout`,
`selectFamily`, `refreshUser`, JWT in `localStorage`). Deployed on Vercel; `/api/*` is rewritten to the
Fly api app, and dev runs over self-signed HTTPS at `sobremesa.x:3000` proxying to the api at `:3001`.

| Route                        | Page             | Auth | Purpose                                                                        |
| ---------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------ |
| `/login`                     | Login            | no   | Telegram login button + public stats; links to the bot, instructs `/sobremesa` |
| `/pass/:token`               | AccessPass       | no   | redeem a pass, then a Welcome modal (confirm/deny/skip identity)               |
| `/select-family`             | SelectFamily     | yes  | choose among families (with role badges)                                       |
| `/family/:familyId`          | App              | yes  | dashboard: family summary + (super-admin) chat allow-list controls             |
| `/family/:familyId/identity` | IdentitySettings | yes  | search/claim/create/edit your person record                                    |

The browser talks to the api through `StudioApiClient` (`libs/api-client`), whose methods mirror the
endpoints above (`loginWithTelegram`, `redeemAccessPass`, `getMe`, `getFamilySummaryById`,
`getIdentity`, `claimIdentity`/`unclaimIdentity`, `listPeople`/`createPerson`/`updatePerson`,
`getAllowedChats`/`authorizeChat`/`removeChat`, `getPublicStats`, `generateNarrative`/`generateBook`).

## 6.5 Chat admin access control

Chat-level authority comes from Telegram itself. `AdminSyncHandler` caches `getChatAdministrators`
results in `chat_admins` (5-min TTL) and is the source of truth for: who may register a family, who may
run `/sobremesa` admin subcommands, and what `role` an access pass grants. Family registration also
requires the chat to be on the super-admin-managed `allowed_chats` allow-list.
