/**
 * Auth Routes
 *
 * Handles authentication endpoints:
 * - POST /api/auth/telegram - Telegram Login Widget callback
 * - GET /api/auth/pass/:token - Redeem access pass
 * - GET /api/auth/me - Get current user + families
 * - POST /api/auth/logout - Clear session (client-side only)
 */

import { Elysia, t } from 'elysia';
import {
  verifyTelegramLogin,
  AuthIdentityRepository,
  FamilyAccessRepository,
  TelegramChatAdminRepository,
  findAccessPassByToken,
  validateAccessPass,
  markAccessPassRedeemed,
  createSessionToken,
  type AuthContext,
  type TelegramLoginData,
} from '@sobremesa/auth';
import { getServiceClient, IdentityRepository } from '@sobremesa/database';

/**
 * Get effective display name from user (canonical) or identity (fallback)
 */
function getEffectiveDisplayName(
  userDisplayName: string | null,
  identityDisplayName: string | null | undefined,
): string | null {
  return userDisplayName || identityDisplayName || null;
}

/**
 * Get effective avatar URL from user (canonical) or identity (fallback)
 */
function getEffectiveAvatarUrl(
  userAvatarUrl: string | null,
  identityAvatarUrl: string | null | undefined,
): string | null {
  return userAvatarUrl || identityAvatarUrl || null;
}

/**
 * Get Telegram bot token from environment
 */
function getTelegramBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
  }
  return token;
}

/**
 * Auth routes Elysia app
 */
export const authRoutes = new Elysia({ prefix: '/api/auth' })
  /**
   * POST /api/auth/telegram
   * Telegram Login Widget callback
   *
   * Verifies Telegram auth data, creates/updates user and identity, returns session token
   */
  .post(
    '/telegram',
    async ({ body, set }) => {
      const telegramData = body as TelegramLoginData;

      // Verify Telegram auth
      const botToken = getTelegramBotToken();
      const isValid = verifyTelegramLogin(telegramData, botToken);

      if (!isValid) {
        set.status = 401;
        return { error: 'Invalid Telegram authentication data' };
      }

      // Find or create user and identity
      const authIdentityRepo = new AuthIdentityRepository();
      const {
        user,
        authIdentity: identity,
        isNew,
      } = await authIdentityRepo.findOrCreateFromTelegramLogin(telegramData);

      // Get family memberships
      const accessRepo = new FamilyAccessRepository();
      const families = await accessRepo.getFamiliesWithRoles(identity.id);

      // If new user, try to create memberships based on cached admin status
      if (isNew) {
        const chatAdminRepo = new TelegramChatAdminRepository();
        const client = getServiceClient();

        // Find all families where this user is a cached admin
        const { data: adminRecords } = await client
          .from('telegram_chat_admins')
          .select('family_id, is_admin')
          .eq('telegram_user_id', telegramData.id);

        if (adminRecords) {
          for (const record of adminRecords) {
            const role = record.is_admin ? 'admin' : 'member';
            await accessRepo.upsert(
              identity.id,
              record.family_id,
              role,
              'telegram_login',
              { notes: 'Auto-created from Telegram login' },
            );
          }

          // Refresh families list
          const updatedFamilies = await accessRepo.getFamiliesWithRoles(
            identity.id,
          );
          families.length = 0;
          families.push(...updatedFamilies);
        }
      }

      // Create session token with userId
      const token = await createSessionToken({
        userId: user.id,
        identityId: identity.id,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        displayName:
          getEffectiveDisplayName(user.displayName, identity.displayName) ||
          undefined,
        role: user.role,
      });

      return {
        token,
        user: {
          id: user.id,
          displayName: getEffectiveDisplayName(
            user.displayName,
            identity.displayName,
          ),
          avatarUrl: getEffectiveAvatarUrl(user.avatarUrl, identity.avatarUrl),
          provider: identity.provider,
          providerUsername: identity.providerUsername,
          role: user.role,
        },
        families,
        isNewUser: isNew,
      };
    },
    {
      body: t.Object({
        id: t.Number(),
        first_name: t.String(),
        last_name: t.Optional(t.String()),
        username: t.Optional(t.String()),
        photo_url: t.Optional(t.String()),
        auth_date: t.Number(),
        hash: t.String(),
      }),
      detail: {
        tags: ['Auth'],
        description: 'Authenticate with Telegram Login Widget',
      },
    },
  )
  /**
   * GET /api/auth/pass/:token
   * Redeem an access pass
   *
   * Validates access pass, creates/updates user and identity, returns session
   */
  .get(
    '/pass/:token',
    async ({ params: { token }, set }) => {
      try {
        // Find access pass
        console.log('[Auth] Looking up access pass...');
        const pass = await findAccessPassByToken(token);

        if (!pass) {
          console.log('[Auth] Access pass not found');
          set.status = 404;
          return { error: 'Access pass not found' };
        }

        console.log('[Auth] Found access pass for family:', pass.familyId);

        // Validate pass
        const validation = validateAccessPass(pass);
        if (!validation.valid) {
          console.log(
            '[Auth] Access pass validation failed:',
            validation.error,
          );
          set.status = 400;
          return { error: validation.error };
        }

        console.log('[Auth] Access pass validated, looking up identity...');

        // Find or create user and identity
        const authIdentityRepo = new AuthIdentityRepository();
        const existingIdentity = await authIdentityRepo.findByProviderUserId(
          pass.provider,
          pass.providerUserId,
        );

        let user;
        let identity;

        if (!existingIdentity) {
          console.log(
            '[Auth] Creating new user and identity for',
            pass.provider,
            'user:',
            pass.providerUserId,
          );
          const created = await authIdentityRepo.createFromAccessPass(
            pass.provider,
            pass.providerUserId,
            null, // no username in access pass
            null, // no display name in access pass (will use default)
          );
          user = created.user;
          identity = created.authIdentity;
          console.log(
            '[Auth] Created user:',
            user.id,
            'and identity:',
            identity.id,
          );
        } else {
          console.log('[Auth] Found existing identity:', existingIdentity.id);
          identity = existingIdentity;
          // Update last login
          await authIdentityRepo.updateLastLogin(identity.id);
          // Get associated user
          user = await authIdentityRepo.getUser(identity.id);
          if (!user) {
            throw new Error('User not found for existing identity');
          }
        }

        // Create or update family membership
        console.log('[Auth] Creating/updating family membership...');
        const accessRepo = new FamilyAccessRepository();
        await accessRepo.upsert(
          identity.id,
          pass.familyId,
          pass.role,
          'access_pass',
          { notes: `Granted via access pass from chat ${pass.chatId}` },
        );

        // Mark pass as redeemed
        console.log('[Auth] Marking pass as redeemed...');
        await markAccessPassRedeemed(pass.id, identity.id);

        // Get all families
        console.log('[Auth] Getting family memberships...');
        const families = await accessRepo.getFamiliesWithRoles(identity.id);

        // Create session token with userId
        console.log('[Auth] Creating session token...');
        const sessionToken = await createSessionToken({
          userId: user.id,
          identityId: identity.id,
          provider: identity.provider,
          providerUserId: identity.providerUserId,
          displayName:
            getEffectiveDisplayName(user.displayName, identity.displayName) ||
            undefined,
          role: user.role,
        });

        console.log('[Auth] Access pass redemption successful');
        return {
          token: sessionToken,
          user: {
            id: user.id,
            displayName: getEffectiveDisplayName(
              user.displayName,
              identity.displayName,
            ),
            avatarUrl: getEffectiveAvatarUrl(
              user.avatarUrl,
              identity.avatarUrl,
            ),
            provider: identity.provider,
            providerUsername: identity.providerUsername,
            role: user.role,
          },
          families,
          grantedFamilyId: pass.familyId,
          grantedRole: pass.role,
        };
      } catch (err) {
        console.error('[Auth] Access pass redemption error:', err);
        set.status = 500;
        return { error: 'Failed to redeem access pass' };
      }
    },
    {
      params: t.Object({ token: t.String() }),
      detail: {
        tags: ['Auth'],
        description: 'Redeem an access pass token',
      },
    },
  )
  /**
   * GET /api/auth/me
   * Get current user info
   *
   * Returns user profile and family memberships for authenticated user
   */
  .get(
    '/me',
    async ({ auth, set }: { auth: AuthContext; set: { status: number } }) => {
      if (!auth.isAuthenticated || !auth.user || !auth.identity) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      // Get fresh family memberships
      const accessRepo = new FamilyAccessRepository();
      const families = await accessRepo.getFamiliesWithRoles(auth.identity.id);

      return {
        user: {
          id: auth.user.id,
          displayName: getEffectiveDisplayName(
            auth.user.displayName,
            auth.identity.displayName,
          ),
          avatarUrl: getEffectiveAvatarUrl(
            auth.user.avatarUrl,
            auth.identity.avatarUrl,
          ),
          provider: auth.identity.provider,
          providerUsername: auth.identity.providerUsername,
          role: auth.user.role,
        },
        families,
      };
    },
    {
      detail: {
        tags: ['Auth'],
        description: 'Get current authenticated user info',
      },
    },
  )
  /**
   * POST /api/auth/logout
   * Logout (client-side token clearing)
   *
   * Returns success - actual token invalidation happens client-side
   */
  .post(
    '/logout',
    () => {
      // Session tokens are stateless JWTs, so logout is handled client-side
      // In the future, we could add token blacklisting here
      return { success: true };
    },
    {
      detail: {
        tags: ['Auth'],
        description: 'Logout (clear session client-side)',
      },
    },
  );
