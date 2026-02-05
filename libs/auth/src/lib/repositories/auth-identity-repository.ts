import type { DatabaseClient } from '@sobremesa/database';
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

  constructor(client: DatabaseClient) {
    this.identityRepo = new IdentityRepository(client);
    this.userRepo = new UserRepository(client);
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
   *
   * Uses retry logic to handle race conditions when two concurrent requests
   * try to create users and link the same identity.
   */
  async findOrCreateFromTelegramLogin(
    telegramData: TelegramLoginData,
  ): Promise<{ user: User; authIdentity: Identity; isNew: boolean }> {
    const providerUserId = String(telegramData.id);
    const displayName = buildDisplayName(
      telegramData.first_name,
      telegramData.last_name,
    );
    const avatarUrl = telegramData.photo_url || null;

    // Find or create the identity
    const { identity, isNew } = await this.identityRepo.findOrCreate(
      'telegram',
      providerUserId,
      telegramData.username || null,
      displayName,
      avatarUrl,
    );

    // If identity already has a user, use it
    if (identity.userId) {
      const user = await this.userRepo.findById(identity.userId);
      if (user) {
        // Sync user profile if needed
        const syncedUser = await this.userRepo.syncProfileFromIdentity(
          user.id,
          displayName,
          avatarUrl,
        );
        return {
          user: syncedUser || user,
          authIdentity: identity,
          isNew: false,
        };
      }
    }

    // Atomically create user and link to identity
    // Use a retry loop to handle race conditions where another request links first
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Create a new user
        const user = await this.userRepo.create({
          displayName,
          avatarUrl,
        });

        // Try to link identity to user (this can fail if another request linked it)
        const linkedIdentity = await this.identityRepo.linkToUser(
          identity.id,
          user.id,
        );

        // Success!
        await this.identityRepo.updateLastLogin(linkedIdentity.id);
        return { user, authIdentity: linkedIdentity, isNew };
      } catch (err) {
        // If linking failed, check if identity was linked by another request
        const refreshedIdentity = await this.identityRepo.findById(identity.id);
        if (refreshedIdentity?.userId) {
          // Another request linked it - use that user
          const existingUser = await this.userRepo.findById(
            refreshedIdentity.userId,
          );
          if (existingUser) {
            return {
              user: existingUser,
              authIdentity: refreshedIdentity,
              isNew: false,
            };
          }
        }

        // If this was the last attempt, throw
        if (attempt === 2) throw err;
      }
    }

    throw new Error('Failed to link identity after retries');
  }

  /**
   * Find or create from any provider.
   * Creates user + identity if new, updates existing if found.
   *
   * Uses retry logic to handle race conditions when two concurrent requests
   * try to create users and link the same identity.
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

    // If identity already has a user, use it
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

    // Atomically create user and link to identity
    // Use a retry loop to handle race conditions where another request links first
    const actualDisplayName = displayName || `User ${providerUserId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Create a new user
        const user = await this.userRepo.create({
          displayName: actualDisplayName,
          avatarUrl: avatarUrl || null,
        });

        // Try to link identity to user (this can fail if another request linked it)
        const linkedIdentity = await this.identityRepo.linkToUser(
          identity.id,
          user.id,
        );

        // Success!
        return { user, authIdentity: linkedIdentity, isNew };
      } catch (err) {
        // If linking failed, check if identity was linked by another request
        const refreshedIdentity = await this.identityRepo.findById(identity.id);
        if (refreshedIdentity?.userId) {
          // Another request linked it - use that user
          const existingUser = await this.userRepo.findById(
            refreshedIdentity.userId,
          );
          if (existingUser) {
            return {
              user: existingUser,
              authIdentity: refreshedIdentity,
              isNew: false,
            };
          }
        }

        // If this was the last attempt, throw
        if (attempt === 2) throw err;
      }
    }

    throw new Error('Failed to link identity after retries');
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

  /**
   * Update identity timezone.
   * IANA timezone string (e.g., 'America/New_York').
   */
  async updateTimezone(
    identityId: string,
    timezone: string,
  ): Promise<Identity | null> {
    return this.identityRepo.updateTimezone(identityId, timezone);
  }
}

/** @deprecated Use AuthIdentityRepository instead */
export const AuthUserRepository = AuthIdentityRepository;
