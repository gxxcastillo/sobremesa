# Admin Error Correction UI - Design Summary

**Status**: Planned (not yet implemented)

## Overview

A web-based admin dashboard for correcting agent errors, with Telegram OAuth authentication and proactive DM notifications when errors occur.

## Architecture

```
apps/admin-ui     → React + Vite + TanStack Query + Tailwind
apps/admin-api    → Fastify REST API + JWT auth
libs/admin        → Shared operations library
```

## Key Decisions

- **Auth**: Telegram Login Widget (HMAC-SHA256 verification using admin bot token)
- **Notifications**: AdminBot sends DM when queue item hits max retries (3)
- **Permissions**: Role-based (queue:read/write, event:read/write/redact, etc.)
- **Audit**: All admin actions logged to `admin_actions` table

## Database (Existing Tables)

Admin authentication uses the existing auth system:

- **`users`** - Global user accounts (role: `user` or `super_admin`)
- **`identities`** - Telegram accounts linked to users
- **`family_access`** - Per-family permissions (role: `admin`/`member`/`viewer`)

```sql
-- Audit trail for admin corrections (to be added)
CREATE TABLE admin_actions (
  id UUID PRIMARY KEY,
  family_id UUID REFERENCES families(id),
  user_id UUID REFERENCES users(id),  -- Uses existing users table
  action_type TEXT,      -- 'edit', 'merge', 'delete', 'redact', 'retry'
  entity_type TEXT,      -- 'event', 'story', 'person', 'relationship', 'claim', 'queue'
  entity_id UUID,
  previous_value JSONB,
  new_value JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Note:** Admin permissions are determined by:

- `users.role = 'super_admin'` → Full access to all families
- `family_access.role = 'admin'` → Admin access to specific family

## UI Pages

| Page               | Purpose                                    |
| ------------------ | ------------------------------------------ |
| Dashboard          | Queue health, recent errors, retry buttons |
| Queue Manager      | Table of queue items, bulk retry, unlock   |
| Event Explorer     | Browse messages, reprocess, redact         |
| Story Editor       | Edit title/themes, merge stories           |
| Person Manager     | Edit people, merge duplicates              |
| Relationship Graph | Visual family tree editor                  |
| Claim Review       | Resolve conflicting claims                 |
| Audit Log          | Searchable event log                       |

## API Endpoints (Summary)

- `POST /auth/telegram` - Verify Telegram login, return JWT
- `GET /queue/stats` - Queue counts by status
- `POST /queue/:id/retry` - Reset item to queued
- `POST /events/:id/reprocess` - Re-enqueue event
- `POST /events/:id/redact` - Mark as redacted
- `PATCH /stories/:id` - Update story fields
- `POST /people/merge` - Merge two people
- `PATCH /relationships/:id` - Update type/confidence
- `PATCH /claims/:id` - Update status (dispute/supersede)

## Error Notification Flow

```
Queue item fails 3x → status = 'error'
                   → ErrorNotifier.notifyProcessingError()
                   → Find admins with queue:read for this family
                   → AdminBot sends DM with error details + link to UI
```

## Implementation Phases

1. **Foundation**: libs/admin types, database migrations, repositories
2. **API Server**: Fastify app, Telegram OAuth, JWT middleware, queue endpoints
3. **Notifications**: ErrorNotifier service, integrate with MessageQueue.fail()
4. **Web UI**: Vite React app, auth flow, Dashboard, Queue Manager
5. **Advanced**: Person merge wizard, relationship graph, bulk operations

## Environment Variables

```env
ADMIN_API_PORT=3001
ADMIN_UI_URL=http://localhost:5173
JWT_SECRET=your-secret-key
TELEGRAM_BOT_TOKEN_ADMIN=xxx  # Existing
DATABASE_URL=postgresql://...  # Existing
```

## Full Spec

See `~/.claude/plans/cosmic-weaving-donut.md` for complete implementation details.
