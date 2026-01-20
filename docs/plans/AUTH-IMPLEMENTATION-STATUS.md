# Auth Implementation Status

**Last Updated:** 2026-01-20
**Status:** Code complete, needs testing and deployment

## Summary

Added authentication and role-based access control to the Studio web app using custom JWT auth with chat provider integration (currently Telegram, extensible to other providers).

## What Was Built

### 1. Database Migration

**File:** `apps/db/supabase/migrations/20260112074715_init_schema.sql` (merged into init schema)

New tables created:

- `auth_identities` - Web auth accounts (id, provider, provider_user_id, role, display_name, avatar_url)
- `family_access` - Links auth_identities to families with roles (admin/member/viewer) and status (active/revoked/suspended)
- `access_passes` - One-time tokens for studio access (provider-agnostic)
- `telegram_chat_admins` - Cached Telegram admin status (Telegram-specific for now)

RLS helper functions:

- `get_auth_identity_id()` - Extract identity from JWT
- `is_super_admin()` - Check super admin role
- `get_user_family_ids()` - Get user's active family IDs
- `get_family_role(family_id)` - Get role in specific family (only if access is active)

### 2. Auth Library

**Location:** `libs/auth/`

| File                                                     | Purpose                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/lib/types.ts`                                       | Type definitions (AuthIdentity, FamilyAccess, SessionPayload, etc.) |
| `src/lib/telegram-verify.ts`                             | Verify Telegram Login Widget HMAC signature                         |
| `src/lib/access-pass.ts`                                 | Generate/validate access pass JWTs                                  |
| `src/lib/repositories/auth-identity-repository.ts`       | Auth identity CRUD operations                                       |
| `src/lib/repositories/family-access-repository.ts`       | Family access operations (with status/revocation)                   |
| `src/lib/repositories/telegram-chat-admin-repository.ts` | Telegram admin cache                                                |
| `src/lib/middleware/auth-plugin.ts`                      | Elysia plugin - derives `auth` context from Bearer token            |
| `src/lib/middleware/guards.ts`                           | Route guards (requireAuth, requireSuperAdmin, etc.)                 |

### 3. API Auth Routes

**File:** `apps/api/src/routes/auth.ts`

| Endpoint                | Method | Purpose                          |
| ----------------------- | ------ | -------------------------------- |
| `/api/auth/telegram`    | POST   | Telegram Login Widget callback   |
| `/api/auth/pass/:token` | GET    | Redeem access pass               |
| `/api/auth/me`          | GET    | Get current user + families      |
| `/api/auth/logout`      | POST   | Clear session (client-side)      |
| `/api/public/stats`     | GET    | Public aggregate stats (no auth) |

**File:** `apps/api/src/main.ts`

- Auth plugin integrated
- All family endpoints check auth inline (using `hasAccessToFamily`)
- Admin endpoints check `isSuperAdmin`

### 4. Telegram Bot Updates

**File:** `libs/telegram/src/lib/chatbot.ts`

New command: `/sobremesa studio-link` (or `/sobremesa studio`)

- Checks if user is admin via `getChatAdministrators()`
- Generates access pass JWT with appropriate role
- Sends link via DM to user

**File:** `libs/telegram/src/lib/handlers/admin-sync.ts`

- `AdminSyncHandler` class for caching Telegram chat admin status
- Methods: `syncChatAdmins()`, `isUserAdmin()`, `handleChatMemberUpdate()`

### 5. Frontend (Studio App)

**Location:** `apps/studio/src/`

| File                                 | Purpose                                         |
| ------------------------------------ | ----------------------------------------------- |
| `context/AuthContext.tsx`            | Auth state management (user, families, tokens)  |
| `components/TelegramLoginButton.tsx` | Telegram Login Widget wrapper                   |
| `components/ProtectedRoute.tsx`      | Route guard component                           |
| `pages/Login.tsx`                    | Landing page with Telegram login + public stats |
| `pages/AccessPass.tsx`               | Handle `/pass/:token` redemption                |
| `pages/SelectFamily.tsx`             | Family picker for multi-family users            |
| `main.tsx`                           | Router setup with AuthProvider                  |
| `app/App.tsx`                        | Auth-aware dashboard                            |

### 6. API Client Updates

**File:** `libs/api-client/src/lib/api-client.ts`

New types exported:

- `AuthIdentity`, `FamilyWithRole`, `TelegramLoginData`
- `TelegramLoginResponse`, `AccessPassRedemptionResponse`, `MeResponse`, `PublicStats`

New methods:

- `setAuthToken(token)` / `clearAuthToken()` / `logout()`
- `loginWithTelegram(data)` - Telegram Login Widget flow
- `redeemAccessPass(token)` - Access pass redemption
- `getMe()` - Current user info
- `getPublicStats()` - Public stats

---

## User Roles

| Role          | Scope      | Permissions                                     |
| ------------- | ---------- | ----------------------------------------------- |
| `super_admin` | Global     | Full access to all families and admin functions |
| `admin`       | Per-family | Manage family data, view conversation events    |
| `member`      | Per-family | View family data                                |
| `viewer`      | Per-family | Read-only access to family data                 |

## Access Status

The `family_access` table includes a `status` field to control access without deletion:

| Status      | Description                           |
| ----------- | ------------------------------------- |
| `active`    | User has active access to the family  |
| `revoked`   | Access explicitly revoked (permanent) |
| `suspended` | Access temporarily suspended          |

When access is revoked/suspended, the record includes:

- `revoked_at` - When the action occurred
- `revoked_by` - User ID who took the action
- `revoke_reason` - Optional explanation

---

## Auth Flows

### Flow A: Telegram Login Widget

1. User clicks "Login with Telegram" on studio
2. Telegram widget returns signed user data
3. API verifies HMAC hash with bot token
4. Find/create `auth_identity`, lookup `family_access` (only active records)
5. Return JWT session token

### Flow B: Access Pass (from Telegram chat)

1. User runs `/sobremesa studio-link` in registered chat
2. Bot checks admin status via `getChatAdministrators()`
3. Bot generates access pass JWT (24h expiry)
4. Bot sends link via DM: `https://studio.../pass/{token}`
5. User clicks link, API validates token, creates session

---

## Environment Variables Needed

```bash
# API (required)
ACCESS_PASS_SECRET=<random-32-char-string>  # For signing JWTs

# Telegram Bot (required for studio-link)
STUDIO_URL=https://studio.sobremesa.app     # Base URL for access pass links

# Studio Frontend (required for Telegram Login)
VITE_TELEGRAM_BOT_NAME=<bot-username>       # Without @ prefix
```

---

## Before Deploying

### 1. Run Database Migration

```bash
# Reset database (auth tables merged into init_schema)
cd apps/db && pnpm supabase db reset
```

### 2. Set Environment Variables

Add the variables listed above to your deployment environment.

### 3. Create Super Admin (Manual)

```sql
-- After a user logs in, promote them to super_admin
UPDATE auth_identities SET role = 'super_admin' WHERE provider = 'telegram' AND provider_user_id = '<your-telegram-id>';
```

---

## Testing Checklist

- [ ] Database migration runs without errors
- [ ] `/api/public/stats` returns data without auth
- [ ] Telegram Login Widget appears on `/login`
- [ ] Login creates `auth_identity` and returns token
- [ ] Protected routes return 401 without token
- [ ] `/sobremesa studio-link` sends DM with link
- [ ] Access pass link logs user in and redirects
- [ ] Family data only visible to members
- [ ] Admin functions only visible to admins/super_admins

---

## Multi-Provider Support

The auth system is designed to be provider-agnostic:

- `auth_identities` table has `provider` and `provider_user_id` columns
- `access_passes` table has `provider`, `provider_user_id`, `provider_username`, `provider_display_name`
- `ChatProvider` type supports: 'telegram', 'discord', 'slack', 'whatsapp', and custom strings

To add a new chat provider:

1. Implement provider-specific login verification (like `telegram-verify.ts`)
2. Add a new API endpoint (like `/api/auth/discord`)
3. Update the chatbot for that provider to generate access passes with the correct `provider` value

---

## Open Questions / Future Work

1. **Supabase Auth vs Custom** - Current implementation uses custom `auth_identities` table with manual JWT handling. Could migrate to Supabase Auth hybrid approach for better session management and native RLS `auth.uid()` support. Trade-off is complexity since Telegram isn't a native Supabase OAuth provider.

2. **Session Refresh** - Current JWTs expire after 7 days with no refresh mechanism. May want to add refresh tokens.

3. **Session Revocation** - No way to invalidate tokens before expiry. Could add a token blacklist table.

4. **Audit Logging** - Auth events (login, logout, pass redemption) not currently logged.

5. **Additional Providers** - Discord and Slack integrations would follow the same pattern as Telegram.

---

## Files Changed Summary

```
Created:
  libs/auth/                              (new library)
  apps/api/src/routes/auth.ts
  apps/studio/src/context/AuthContext.tsx
  apps/studio/src/components/TelegramLoginButton.tsx
  apps/studio/src/components/ProtectedRoute.tsx
  apps/studio/src/pages/Login.tsx
  apps/studio/src/pages/AccessPass.tsx
  apps/studio/src/pages/SelectFamily.tsx
  libs/telegram/src/lib/handlers/admin-sync.ts

Modified:
  apps/db/supabase/migrations/20260112074715_init_schema.sql (auth tables merged)
  apps/api/src/main.ts                    (auth plugin, protected routes)
  apps/studio/src/main.tsx                (router, AuthProvider)
  apps/studio/src/app/App.tsx             (auth-aware UI)
  libs/api-client/src/lib/api-client.ts   (auth types & methods)
  libs/telegram/src/lib/chatbot.ts        (studio-link command)
```

---

## Build Status

All projects build successfully as of 2026-01-16:

- api-client
- studio
- api
- chatbots
