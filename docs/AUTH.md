# Authentication and Authorization

**JWT-based auth system with family-scoped multi-tenancy and role-based access control.**

---

## Overview

Sobremesa uses custom JWT authentication that integrates with chat providers (currently Telegram). Users can access the Studio web app through:

- **Telegram Login Widget** - Direct web login with Telegram account
- **Access Pass** - One-time token generated from Telegram bot command

All access is scoped by family with role-based permissions.

---

## Architecture

### Database Tables

**`auth_identities`** - Web authentication accounts

- `id` (UUID) - Primary key
- `provider` - Auth provider (currently "telegram")
- `provider_user_id` - Provider's user ID
- `role` - Global role (`super_admin` or null)
- `display_name`, `avatar_url` - Profile information
- `created_at`, `last_login_at` - Timestamps

**`family_access`** - Family-scoped access control

- `id` (UUID) - Primary key
- `auth_identity_id` - Reference to auth_identities
- `family_id` - Reference to families
- `role` - Family-specific role (`admin`, `member`, `viewer`)
- `status` - Access status (`active`, `revoked`, `suspended`)
- `granted_by`, `granted_at` - Audit trail
- `revoked_by`, `revoked_at`, `revoke_reason` - Revocation tracking

**`access_passes`** - One-time access tokens

- `id` (UUID) - Primary key
- `family_id` - Target family
- `role` - Role to grant
- `token` - JWT token (indexed)
- `expires_at` - Token expiration
- `used_at`, `used_by` - Usage tracking
- `generated_by_provider`, `generated_by_provider_user_id` - Audit trail

**`telegram_chat_admins`** - Cached Telegram admin status

- `telegram_chat_id`, `telegram_user_id` - Composite key
- `is_admin` - Admin status
- `cached_at` - Cache timestamp

### RLS Helper Functions

**`get_auth_identity_id()`** - Extract identity ID from JWT

```sql
-- Returns auth_identity_id from current_setting('request.jwt.claims')::json->'sub'
```

**`is_super_admin()`** - Check global admin role

```sql
-- Returns true if current user has role='super_admin'
```

**`get_user_family_ids()`** - Get accessible families

```sql
-- Returns array of family_ids where user has active access
```

**`get_family_role(family_id)`** - Get role in specific family

```sql
-- Returns role if user has active access to family, null otherwise
```

---

## User Roles

### Global Roles

**`super_admin`** (stored in `auth_identities.role`)

- Full access to all families
- Access to admin functions and stats
- Can grant/revoke family access
- No family-specific permission checks

### Family-Scoped Roles

Stored in `family_access.role`, only effective when `status = 'active'`:

**`admin`**

- Manage family data
- View conversation events
- Grant family access to others
- Revoke non-admin access

**`member`**

- View family data
- Edit entities and claims (future)
- Cannot manage access

**`viewer`**

- Read-only access to family data
- Cannot edit anything

---

## Access Status

The `family_access.status` field controls access:

**`active`** - User has access to the family

**`revoked`** - Access explicitly revoked (permanent)

- User cannot access family
- Record preserved for audit trail
- Includes `revoked_by`, `revoked_at`, `revoke_reason`

**`suspended`** - Access temporarily suspended

- User cannot access family
- Can be reactivated by admin
- Includes suspension metadata

**Important:** All permission checks filter by `status = 'active'`.

---

## Authentication Flows

### Flow A: Telegram Login Widget

Standard web login using Telegram's authentication:

1. User clicks "Login with Telegram" button on Studio login page
2. Telegram Login Widget appears (configured with `VITE_TELEGRAM_BOT_NAME`)
3. User authorizes through Telegram
4. Widget returns signed user data with HMAC hash
5. Frontend sends data to `POST /api/auth/telegram`
6. API verifies HMAC signature using bot token
7. API finds or creates `auth_identity` record
8. API loads `family_access` records (only `status = 'active'`)
9. API returns JWT session token with:
   - `sub`: auth_identity_id
   - `role`: super_admin or null
   - `families`: array of { family_id, role }
10. Frontend stores token and redirects to family selection or dashboard

**Environment variables:**

```bash
# Frontend
VITE_TELEGRAM_BOT_NAME=your_bot_username  # Without @ prefix

# API
ACCESS_PASS_SECRET=your-secret-key  # For JWT signing
```

### Flow B: Access Pass (from Bot)

Generate temporary access link from Telegram chat:

1. User runs `/sobremesa studio-link` (or `/sobremesa studio`) in registered chat
2. Bot checks if user is admin via `getChatAdministrators()` API
3. Bot determines role based on admin status:
   - Chat admin → family `admin` role
   - Regular member → family `member` role
4. Bot generates access pass JWT (24-hour expiry)
5. Bot inserts record into `access_passes` table
6. Bot sends link via DM: `https://studio.../pass/{token}`
7. User clicks link, redirected to `GET /api/auth/pass/:token`
8. API validates token:
   - Checks `expires_at`
   - Checks not already used (`used_at IS NULL`)
9. API finds or creates `auth_identity` for Telegram user
10. API creates/updates `family_access` record with status `active`
11. API marks access pass as used
12. API returns JWT session token
13. Frontend stores token and redirects to dashboard

**Environment variables:**

```bash
# Bot
STUDIO_URL=https://studio.sobremesa.app  # Base URL for access pass links

# API
ACCESS_PASS_SECRET=your-secret-key  # Same secret for validation
```

---

## API Integration

### Auth Plugin (Elysia Middleware)

**Location:** `libs/auth/src/lib/middleware/auth-plugin.ts`

Derives `auth` context from Bearer token:

```typescript
app.use(authPlugin()).get('/protected', ({ auth }) => {
  // auth = { identityId, role, families: [...] }
});
```

Extracts JWT from `Authorization: Bearer <token>` header.

### Route Guards

**Location:** `libs/auth/src/lib/middleware/guards.ts`

**`requireAuth()`** - Require any authenticated user

```typescript
app.get('/api/auth/me', requireAuth(), ({ auth }) => {
  // auth is guaranteed to exist
});
```

**`requireSuperAdmin()`** - Require super admin role

```typescript
app.get('/api/admin/stats', requireSuperAdmin(), ({ auth }) => {
  // auth.role === 'super_admin'
});
```

**`requireFamilyAccess(familyId, minRole?)`** - Require family access with optional minimum role

```typescript
app.get(
  '/api/families/:familyId/people',
  requireAuth(),
  async ({ auth, params }) => {
    const familyId = params.familyId;

    // Manual check (pattern used in current code)
    const hasAccess = hasAccessToFamily(auth, familyId);
    if (!hasAccess) throw new Error('Unauthorized');

    // Or use guard (future)
    // requireFamilyAccess(familyId, 'member')
  },
);
```

### Helper Functions

**`hasAccessToFamily(auth, familyId)`** - Check family access

```typescript
function hasAccessToFamily(auth: AuthContext, familyId: string): boolean {
  if (auth.role === 'super_admin') return true;
  return auth.families.some((f) => f.familyId === familyId);
}
```

**`isSuperAdmin(auth)`** - Check super admin

```typescript
function isSuperAdmin(auth: AuthContext): boolean {
  return auth.role === 'super_admin';
}
```

**`getFamilyRole(auth, familyId)`** - Get role in family

```typescript
function getFamilyRole(auth: AuthContext, familyId: string): string | null {
  if (auth.role === 'super_admin') return 'admin';
  const access = auth.families.find((f) => f.familyId === familyId);
  return access?.role || null;
}
```

---

## Frontend Integration

### AuthContext

**Location:** `apps/studio/src/context/AuthContext.tsx`

Provides auth state throughout app:

```typescript
const { user, families, loading, login, logout } = useAuth();

// user: AuthIdentity | null
// families: FamilyWithRole[]
// loading: boolean
// login: (token: string) => void
// logout: () => void
```

State persistence:

- JWT token stored in `localStorage`
- Token sent in `Authorization: Bearer <token>` header
- Automatic logout on 401 responses

### Protected Routes

**Location:** `apps/studio/src/components/ProtectedRoute.tsx`

Wraps routes requiring authentication:

```typescript
<Route path="/dashboard" element={
  <ProtectedRoute>
    <Dashboard />
  </ProtectedRoute>
} />
```

Redirects to `/login` if not authenticated.

### API Client

**Location:** `libs/api-client/src/lib/api-client.ts`

**Authentication methods:**

```typescript
// Set token (stores in memory)
apiClient.setAuthToken(token);

// Clear token
apiClient.clearAuthToken();

// Login with Telegram
const response = await apiClient.loginWithTelegram(telegramData);
apiClient.setAuthToken(response.token);

// Redeem access pass
const response = await apiClient.redeemAccessPass(token);
apiClient.setAuthToken(response.token);

// Get current user
const me = await apiClient.getMe();
// { user: AuthIdentity, families: FamilyWithRole[] }

// Logout (client-side only)
await apiClient.logout();
```

All subsequent API calls automatically include `Authorization` header.

---

## Security Considerations

### JWT Security

- Tokens stored client-side (localStorage)
- Tokens include expiration (`exp` claim)
- Secret key (`ACCESS_PASS_SECRET`) must be kept secure
- Tokens cannot be revoked server-side (short expiry recommended)

### HMAC Verification

Telegram Login Widget data verified via HMAC:

- Uses bot token as secret key
- Prevents tampering with user data
- Implementation in `libs/auth/src/lib/telegram-verify.ts`

### Access Pass Security

- One-time use (marked as used after redemption)
- 24-hour expiration
- Linked to specific family
- Audit trail (generated_by, used_by)

### Row-Level Security (RLS)

RLS policies use helper functions to enforce:

- Super admins bypass family checks
- Regular users can only access families where `family_access.status = 'active'`
- RLS applies at database level (defense in depth)

---

## Deployment Checklist

1. **Database migration**

   ```bash
   cd apps/db && pnpm supabase db reset
   ```

2. **Environment variables**
   - API: `ACCESS_PASS_SECRET`
   - Bot: `STUDIO_URL`
   - Frontend: `VITE_TELEGRAM_BOT_NAME`

3. **Create first super admin**

   ```sql
   -- After user logs in via Telegram
   UPDATE auth_identities
   SET role = 'super_admin'
   WHERE provider = 'telegram'
     AND provider_user_id = 'YOUR_TELEGRAM_ID';
   ```

4. **Test authentication flows**
   - Telegram Login Widget on `/login`
   - Access pass generation via `/sobremesa studio-link`
   - Access pass redemption
   - Protected route access

---

## See Also

- [DATA-ISOLATION.md](DATA-ISOLATION.md) - Family-scoped data model
- [ADR-017](adr/017-family-scoped-data.md) - Family-scoped data decision
- [ADR-021](adr/021-one-bot-per-family.md) - One bot per family
