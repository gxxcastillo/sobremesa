/**
 * Auth types for Sobremesa authentication system
 *
 * Unified identity model:
 * - users: Global user accounts (cross-provider identity, owns role)
 * - identities: Global provider credentials (one per provider account)
 * - family_access: Per-family permissions + person claims
 */

// Re-export Identity from shared-types for convenience
export type { Identity } from '@sobremesa/shared-types';

// Chat provider type (compatible with shared-types ChatProvider)
export type ChatProvider =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'whatsapp'
  | string;

// User roles at the global level
export type GlobalRole = 'user' | 'super_admin';

// User roles at the family level
export type FamilyRole = 'admin' | 'member' | 'viewer';

// Access pass status
export type AccessPassStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

// Family access status
export type FamilyAccessStatus = 'pending' | 'active' | 'revoked' | 'suspended';

// How access was granted
export type AccessGrantedBy =
  | 'system'
  | 'admin'
  | 'telegram_login'
  | 'access_pass'
  | 'chat_join'
  | 'studio_link';

/**
 * User record (from users table)
 * Represents a global user account that can link multiple provider identities
 */
export interface User {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: GlobalRole;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Family access record (from family_access table)
 * Controls who can access a family via the web/Studio app.
 * Also stores the user's claimed person_id in each family's genealogy.
 */
export interface FamilyAccess {
  id: string;
  identityId: string;
  familyId: string;
  role: FamilyRole;
  status: FamilyAccessStatus;
  /** User-claimed identity: who this user is in this family's genealogy */
  personId: string | null;
  grantedBy: AccessGrantedBy;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Access pass record (from access_passes table)
 */
export interface AccessPass {
  id: string;
  tokenHash: string;
  familyId: string;
  role: FamilyRole;
  provider: ChatProvider;
  providerUserId: string;
  identityId: string | null;
  chatId: string;
  expiresAt: Date;
  status: AccessPassStatus;
  redeemedAt: Date | null;
  redeemedByIdentityId: string | null;
  createdAt: Date;
}

/**
 * Telegram chat admin record (from telegram_chat_admins table)
 */
export interface TelegramChatAdmin {
  id: string;
  familyId: string;
  chatId: string;
  telegramUserId: number;
  isAdmin: boolean;
  adminTitle: string | null;
  canManageChat: boolean;
  canDeleteMessages: boolean;
  permissions: Record<string, boolean>;
  providerUserId: string;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Telegram Login Widget data (from login widget callback)
 */
export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Session data stored in JWT
 */
export interface SessionPayload {
  userId: string; // Primary identifier from users table
  identityId: string; // Identity used for this session
  provider?: ChatProvider;
  providerUserId?: string;
  displayName?: string;
  role: GlobalRole; // From users table
  iat?: number;
  exp?: number;
}

/**
 * Auth context derived from request (for Elysia plugin)
 */
export interface AuthContext {
  user: User | null; // The global user (from users table)
  identity: import('@sobremesa/shared-types').Identity | null; // The provider identity
  isAuthenticated: boolean;
  isSuperAdmin: boolean;
  familyAccess: FamilyAccess[];
}

/**
 * Family with membership info (for user's family list)
 */
export interface FamilyWithRole {
  familyId: string;
  familyName: string;
  role: FamilyRole;
  status: FamilyAccessStatus;
  personId: string | null;
  grantedAt: Date;
}

/**
 * Result of access pass redemption
 */
export interface AccessPassRedemptionResult {
  success: boolean;
  identity?: import('@sobremesa/shared-types').Identity;
  familyAccess?: FamilyAccess;
  error?: string;
}

/**
 * Result of Telegram login
 */
export interface TelegramLoginResult {
  success: boolean;
  identity?: import('@sobremesa/shared-types').Identity;
  families?: FamilyWithRole[];
  isNewUser?: boolean;
  error?: string;
}

/**
 * Input for creating an access pass
 */
export interface CreateAccessPassInput {
  familyId: string;
  role: FamilyRole;
  provider: ChatProvider;
  providerUserId: string;
  identityId?: string;
  chatId: string;
  expiresInHours?: number;
}

/**
 * Result of creating an access pass
 */
export interface CreateAccessPassResult {
  success: boolean;
  token?: string;
  expiresAt?: Date;
  error?: string;
}

// ============================================================================
// Deprecated aliases - will be removed in future version
// ============================================================================

/** @deprecated Use AccessGrantedBy instead */
export type MembershipGrantedBy = AccessGrantedBy;

/** @deprecated Use Identity from @sobremesa/shared-types instead */
export type AuthIdentity = import('@sobremesa/shared-types').Identity;

/** @deprecated Use Identity from @sobremesa/shared-types instead */
export type AuthUser = import('@sobremesa/shared-types').Identity;
