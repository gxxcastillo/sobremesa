# Authentication and Authorization

**JWT-based auth system with family-scoped multi-tenancy and role-based access control.**

---

## Overview

Sobremesa uses custom JWT authentication integrated with Telegram. Users access Studio web app through:

- **Telegram Login Widget** - Direct web login with Telegram account
- **Access Pass** - One-time token from bot command (`/sobremesa studio-link`)

All access is scoped by family with role-based permissions.

---

## Database Tables

**`users`** - Global user accounts for web authentication

- Global role (`user` or `super_admin`), display name, avatar, email
- One user can have multiple linked identities (cross-provider)

**`identities`** - Chat provider accounts (global)

- Provider (Telegram, WhatsApp, etc.), provider user ID, profile info
- Optionally linked to a `users` record for web login
- Created when user sends a message or logs in

**`family_access`** - Family-scoped access control

- Links identity to family with role (`admin`/`member`/`viewer`) and status
- Stores person claim (`person_id`) - who this user is in the family tree
- Audit trail for grants and revocations

**`access_passes`** - One-time access tokens

- 24-hour expiry, single-use, family-scoped
- Generated via bot, redeemed on web
- Status: `pending` → `processing` → `redeemed` (or `expired`/`revoked`)

**`chat_admins`** - Cached admin status from chat providers

- Synced from Telegram's `getChatAdministrators()` API
- Used at login to determine initial `family_access.role`
- NOT used for authorization (family_access is authoritative)

---

## User Roles

### Global

**`super_admin`** - Full access to all families, admin functions, no permission checks

### Family-Scoped

**`admin`** - Manage family data, grant access, view events

**`member`** - View and edit family data (future: edit capabilities)

**`viewer`** - Read-only access

**Note:** Roles only effective when `family_access.status = 'active'`

---

## Authentication Flows

### Telegram Login Widget

1. User clicks "Login with Telegram" on Studio
2. Telegram widget authenticates and returns signed data with HMAC
3. API verifies HMAC, finds or creates identity + user
4. If new user, checks `chat_admins` cache to assign initial family roles
5. Returns JWT with userId, identityId, role, families
6. Frontend stores token, redirects to dashboard

### Access Pass (from Bot)

1. User runs `/sobremesa studio-link` in Telegram
2. Bot checks admin status, generates access pass (24hr expiry)
3. Bot inserts access pass record, sends DM with link
4. User clicks link, API atomically claims and validates pass
5. API creates/updates user, identity, and family access
6. Returns session JWT, frontend stores token, redirects to dashboard

---

## Security

**JWT:** Stored client-side (localStorage), includes expiration, cannot be revoked server-side

**HMAC Verification:** Telegram widget data signed with bot token, prevents tampering

**Access Passes:** One-time use, 24hr expiry, family-scoped, full audit trail

**Row-Level Security:** Database policies enforce family scoping, super admins bypass checks

---

## API Integration

**Auth Plugin:** Elysia middleware extracts JWT from Bearer token, provides `auth` context

**Route Guards:**

- `requireAuth()` - Any authenticated user
- `requireSuperAdmin()` - Super admin only
- `requireFamilyAccess(familyId, minRole?)` - Family-scoped access

**Helper Functions:** `hasAccessToFamily()`, `isSuperAdmin()`, `getFamilyRole()`

---

## Frontend

**AuthContext:** Provides auth state (`user`, `families`, `login`, `logout`)

**Protected Routes:** Redirect to `/login` if not authenticated

**API Client:** Manages token storage, auto-includes in headers

---

## See Also

- [DATA-ISOLATION.md](DATA-ISOLATION.md) - Family-scoped data model
- [ADR-017](adr/017-family-scoped-data.md) - Family-scoped data decision
- [ADR-021](adr/021-one-bot-per-family.md) - One bot per family
