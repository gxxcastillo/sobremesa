# Studio Admin Features

**Status**: Partially implemented (Studio + API apps exist, admin features in progress)

## Current Architecture

The admin dashboard is built into the existing Studio and API apps, not as separate applications.

```
apps/studio    → SolidJS + Vite (web UI)
apps/api       → Elysia REST API + JWT auth
libs/auth      → Authentication (JWT, access passes, Telegram login)
libs/api-client → Shared API client
libs/database  → Repositories (data access)
```

## Authentication

Uses the existing auth system (see `docs/AUTH.md`):

- **Telegram Login Widget** — Direct web login via Telegram OAuth (HMAC-SHA256 verification)
- **Access Pass** — One-time token from bot command (`/sobremesa studio-link`)
- **JWT** — Session tokens with userId, identityId, role, families
- **Single bot** — One `TELEGRAM_BOT_TOKEN` for all interactions

### Permissions

- **`users.role = 'super_admin'`** — Full access to all families
- **`family_access.role = 'admin'`** — Admin access to specific family
- **`family_access.role = 'member'`** — View and edit family data
- **`family_access.role = 'viewer'`** — Read-only access

## Planned Admin Pages

| Page               | Purpose                                    | Status  |
| ------------------ | ------------------------------------------ | ------- |
| Dashboard          | Queue health, recent errors, retry buttons | Planned |
| Identity Settings  | Manage family identity claims              | Started |
| Queue Manager      | Table of queue items, bulk retry, unlock   | Planned |
| Event Explorer     | Browse messages, reprocess, redact         | Planned |
| Story Editor       | Edit title/themes, merge stories           | Planned |
| Person Manager     | Edit people, merge duplicates              | Planned |
| Relationship Graph | Visual family tree editor                  | Planned |
| Claim Review       | Resolve conflicting claims                 | Planned |
| Audit Log          | Searchable event log                       | Planned |

## API Endpoints (Planned)

The API app (`apps/api`) uses Elysia and provides:

- `POST /auth/telegram` — Verify Telegram login, return JWT
- `POST /auth/access-pass` — Redeem access pass, return JWT
- `GET /families/:id` — Family details and config
- `GET /queue/stats` — Queue counts by status
- `POST /queue/:id/retry` — Reset item to queued
- `POST /events/:id/reprocess` — Re-enqueue event
- `POST /events/:id/redact` — Mark as redacted
- `PATCH /stories/:id` — Update story fields
- `POST /people/merge` — Merge two people
- `PATCH /relationships/:id` — Update type/confidence
- `PATCH /claims/:id` — Update status (dispute/supersede)

## Error Notification Flow (Planned)

```
Queue item fails 3x → status = 'error'
                   → Find admins for this family via family_access
                   → Bot sends DM with error details + link to Studio
```

## Environment Variables

```env
# Required (already in .env.example)
TELEGRAM_BOT_TOKEN=123:ABC
ACCESS_PASS_SECRET=your-secret-key
STUDIO_URL=https://sobremesa.x:3000
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## Implementation Phases

1. **Foundation** (done): Auth system, JWT, access passes, identity management
2. **Studio Shell** (done): SolidJS app, routing, auth context, login flow
3. **Identity Settings** (in progress): Manage family member identity claims
4. **Queue Management**: View queue status, retry failed items, unlock stuck items
5. **Data Exploration**: Browse events, people, claims, stories
6. **Admin Tools**: Person merge wizard, claim review, relationship graph
