/**
 * AuthIdentityRepository
 *
 * Handles web authentication identity operations.
 * This is now a facade over the unified IdentityRepository + UserRepository,
 * providing convenience methods for the web auth flow.
 *
 * The unified model:
 * - identities: Global provider accounts (e.g., Telegram user 12345)
 * - users: Global user accounts for cross-provider linking
 * - family_access: Per-family permissions and person claims
 */

import { IdentityRepository } from '@sobremesa/database';
import type { Identity } from '@sobremesa/shared-types';
import type { User, TelegramLoginData, ChatProvider } from '../types';
import { buildDisplayName } from '../telegram-verify';
import { UserRepository } from './user-repository';

export class AuthIdentityRepository {
  private identityRepo: IdentityRepository;
  private userRepo: UserRepository;

  constructor() {
    this.identityRepo = new IdentityRepository();
    this.userRepo = new UserRepository();
  }

  /**
   * Find identity by ID.
   */
  async findById(id: string): Promise<Identity | null> {
    return this.identityRepo.findById(id);
  }

  /**
   * Find identity by provider and provider user ID.
   */
  async findByProviderUserId(
    provider: ChatProvider,
    providerUserId: string,
  ): Promise<Identity | null> {
    return this.identityRepo.findByProviderUserId(provider, providerUserId);
  }

  /**
   * Find identity by Telegram user ID.
   * Convenience method for Telegram-specific lookups.
   */
  async findByTelegramUserId(telegramUserId: number): Promise<Identity | null> {
    return this.identityRepo.findByTelegramUserId(telegramUserId);
  }

  /**
   * Find or create a user and identity from Telegram Login Widget data.
   * Creates a users record for web auth, links identity to it.
   *
   * Returns both the identity (as `authIdentity` for backward compatibility) and user.
   */
  async findOrCreateFromTelegramLogin(
    telegramData: TelegramLoginData,
  ): Promise<{ user: User; authIdentity: Identity; isNew: boolean }> {
    const providerUserId = String(telegramData.id);
    const displayName = buildDisplayName(
      telegramData.first_name,
      telegramData.last_name,
    );

    // Find or create the identity
    const { identity, isNew } = await this.identityRepo.findOrCreate(
      'telegram',
      providerUserId,
      telegramData.username || null,
      displayName,
      telegramData.photo_url || null,
    );

    // If identity has a user, fetch it
    if (identity.userId) {
      const user = await this.userRepo.findById(identity.userId);
      if (user) {
        // Sync user profile if needed
        const syncedUser = await this.userRepo.syncProfileFromIdentity(
          user.id,
          displayName,
          telegramData.photo_url || null,
        );
        return {
          user: syncedUser || user,
          authIdentity: identity,
          isNew: false,
        };
      }
    }

    // Create a new user and link to identity
    const user = await this.userRepo.create({
      displayName,
      avatarUrl: telegramData.photo_url || null,
    });

    // Link identity to user
    const linkedIdentity = await this.identityRepo.linkToUser(
      identity.id,
      user.id,
    );

    // Update last login
    await this.identityRepo.updateLastLogin(linkedIdentity.id);

    return { user, authIdentity: linkedIdentity, isNew };
  }

  /**
   * Find or create from any provider.
   * Creates user + identity if new, updates existing if found.
   */
  async findOrCreateFromProvider(
    provider: ChatProvider,
    providerUserId: string,
    providerUsername?: string | null,
    displayName?: string | null,
    avatarUrl?: string | null,
  ): Promise<{ user: User; authIdentity: Identity; isNew: boolean }> {
    // Find or create the identity
    const { identity, isNew } = await this.identityRepo.findOrCreate(
      provider,
      providerUserId,
      providerUsername,
      displayName,
      avatarUrl,
    );

    // If identity has a user, fetch it
    if (identity.userId) {
      const user = await this.userRepo.findById(identity.userId);
      if (user) {
        // Sync user profile if needed
        const syncedUser = await this.userRepo.syncProfileFromIdentity(
          user.id,
          displayName || null,
          avatarUrl || null,
        );
        return {
          user: syncedUser || user,
          authIdentity: identity,
          isNew: false,
        };
      }
    }

    // Create a new user and link to identity
    const actualDisplayName = displayName || `User ${providerUserId}`;
    const user = await this.userRepo.create({
      displayName: actualDisplayName,
      avatarUrl: avatarUrl || null,
    });

    // Link identity to user
    const linkedIdentity = await this.identityRepo.linkToUser(
      identity.id,
      user.id,
    );

    return { user, authIdentity: linkedIdentity, isNew };
  }

  /**
   * Create a user and identity from access pass data (minimal info).
   */
  async createFromAccessPass(
    provider: ChatProvider,
    providerUserId: string,
    providerUsername: string | null,
    displayName: string | null,
    avatarUrl?: string | null,
  ): Promise<{ user: User; authIdentity: Identity }> {
    const actualDisplayName = displayName || `User ${providerUserId}`;

    // Create user first
    const user = await this.userRepo.create({
      displayName: actualDisplayName,
      avatarUrl: avatarUrl || null,
    });

    // Create identity linked to user
    const identity = await this.identityRepo.create({
      userId: user.id,
      provider,
      providerUserId,
      providerUsername,
      displayName: actualDisplayName,
      avatarUrl,
      isActive: true,
    });

    return { user, authIdentity: identity };
  }

  /**
   * Update last login timestamp.
   */
  async updateLastLogin(identityId: string): Promise<void> {
    return this.identityRepo.updateLastLogin(identityId);
  }

  /**
   * Get the user associated with an identity.
   */
  async getUser(identityId: string): Promise<User | null> {
    const identity = await this.identityRepo.findById(identityId);
    if (!identity?.userId) {
      return null;
    }
    return this.userRepo.findById(identity.userId);
  }

  /**
   * Update identity profile (display name, avatar, username).
   */
  async updateProfile(
    identityId: string,
    updates: {
      providerUsername?: string | null;
      displayName?: string | null;
      avatarUrl?: string | null;
    },
  ): Promise<Identity | null> {
    return this.identityRepo.updateProfile(identityId, updates);
  }

  /**
   * Update identity profile from Telegram data.
   */
  async updateFromTelegramData(
    id: string,
    telegramData: TelegramLoginData,
  ): Promise<Identity | null> {
    const displayName = buildDisplayName(
      telegramData.first_name,
      telegramData.last_name,
    );

    return this.updateProfile(id, {
      providerUsername: telegramData.username || null,
      displayName,
      avatarUrl: telegramData.photo_url || null,
    });
  }

  /**
   * Check if identity's user is super admin.
   */
  async isSuperAdmin(identityId: string): Promise<boolean> {
    const user = await this.getUser(identityId);
    return user?.role === 'super_admin';
  }
}

/** @deprecated Use AuthIdentityRepository instead */
export const AuthUserRepository = AuthIdentityRepository;
