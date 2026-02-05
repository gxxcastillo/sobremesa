/**
 * Auth Routes
 *
 * Handles authentication endpoints:
 * - POST /api/auth/telegram - Telegram Login Widget callback
 * - GET /api/auth/pass/:token - Redeem access pass
 * - GET /api/auth/me - Get current user + families
 * - POST /api/auth/logout - Clear session (client-side only)
 */

import { AnyElysia, Elysia, t } from 'elysia';
import type { DatabaseClient } from '@sobremesa/database';
import {
  verifyTelegramLogin,
  AuthIdentityRepository,
  FamilyAccessRepository,
  claimAccessPass,
  markAccessPassRedeemed,
  createSessionToken,
  type TelegramLoginData,
} from '@sobremesa/auth';

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
 * Get ACCESS_PASS_SECRET from environment
 */
function getAccessPassSecret(): string {
  const secret = process.env.ACCESS_PASS_SECRET;
  if (!secret) {
    throw new Error('ACCESS_PASS_SECRET environment variable is required');
  }
  return secret;
}

/**
 * Auth routes factory - accepts dbClient
 */
export function authRoutes<T extends AnyElysia>(dbClient: DatabaseClient) {
  const secret = getAccessPassSecret();

  const elysia = new Elysia({ prefix: '/api/auth' }) as T;
  return (
    elysia
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
          const authIdentityRepo = new AuthIdentityRepository(dbClient);
          const {
            user,
            authIdentity: identity,
            isNew,
          } = await authIdentityRepo.findOrCreateFromTelegramLogin(
            telegramData,
          );

          // Get family memberships
          const accessRepo = new FamilyAccessRepository(dbClient);
          const families = await accessRepo.getFamiliesWithRoles(identity.id);

          // If new user, try to create memberships based on cached admin status
          if (isNew) {
            // Find all families where this user is a cached admin
            const { data: adminRecords } = await dbClient
              .from('chat_admins')
              .select('family_id, is_admin')
              .eq('source', 'telegram')
              .eq('provider_user_id', String(telegramData.id));

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
          const token = await createSessionToken(
            {
              userId: user.id,
              identityId: identity.id,
              provider: identity.provider,
              providerUserId: identity.providerUserId,
              displayName:
                getEffectiveDisplayName(
                  user.displayName,
                  identity.displayName,
                ) || undefined,
              role: user.role,
            },
            secret,
          );

          return {
            token,
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
            // Atomically claim the access pass (validates + marks as processing)
            console.log('[Auth] Claiming access pass...');
            const claimResult = await claimAccessPass(dbClient, token);

            if (claimResult.success === false) {
              console.log(
                '[Auth] Access pass claim failed:',
                claimResult.error,
              );
              set.status =
                claimResult.error === 'Access pass not found' ? 404 : 400;
              return { error: claimResult.error };
            }

            const pass = claimResult.pass;
            console.log(
              '[Auth] Access pass claimed for family:',
              pass.familyId,
            );
            console.log('[Auth] Looking up identity...');

            // Find or create user and identity
            const authIdentityRepo = new AuthIdentityRepository(dbClient);
            const existingIdentity =
              await authIdentityRepo.findByProviderUserId(
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
              console.log(
                '[Auth] Found existing identity:',
                existingIdentity.id,
              );
              identity = existingIdentity;
              // Update last login
              await authIdentityRepo.updateLastLogin(identity.id);
              // Get associated user (may not exist for old identities)
              user = await authIdentityRepo.getUser(identity.id);
              if (!user) {
                // Identity exists but has no user - create one and link
                console.log('[Auth] Identity has no user, creating one...');
                const result = await authIdentityRepo.findOrCreateFromProvider(
                  pass.provider,
                  pass.providerUserId,
                  identity.providerUsername,
                  identity.displayName,
                  identity.avatarUrl,
                );
                user = result.user;
                identity = result.authIdentity;
                console.log('[Auth] Created and linked user:', user.id);
              }
            }

            // Create or update family membership
            console.log('[Auth] Creating/updating family membership...');
            const accessRepo = new FamilyAccessRepository(dbClient);
            await accessRepo.upsert(
              identity.id,
              pass.familyId,
              pass.role,
              'access_pass',
              { notes: `Granted via access pass from chat ${pass.chatId}` },
            );

            // Mark pass as redeemed
            console.log('[Auth] Marking pass as redeemed...');
            await markAccessPassRedeemed(dbClient, pass.id, identity.id);

            // Get all families
            console.log('[Auth] Getting family memberships...');
            const families = await accessRepo.getFamiliesWithRoles(identity.id);

            // Create session token with userId
            console.log('[Auth] Creating session token...');
            const sessionToken = await createSessionToken(
              {
                userId: user.id,
                identityId: identity.id,
                provider: identity.provider,
                providerUserId: identity.providerUserId,
                displayName:
                  getEffectiveDisplayName(
                    user.displayName,
                    identity.displayName,
                  ) || undefined,
                role: user.role,
              },
              secret,
            );

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
        async ({ auth, set }) => {
          if (!auth.isAuthenticated || !auth.user || !auth.identity) {
            set.status = 401;
            return { error: 'Not authenticated' };
          }

          // Get fresh family memberships
          const accessRepo = new FamilyAccessRepository(dbClient);
          const families = await accessRepo.getFamiliesWithRoles(
            auth.identity.id,
          );

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
              timezone: auth.identity.timezone || null,
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
       * PATCH /api/auth/me/timezone
       * Update current user's timezone
       *
       * Auto-detects timezone from browser or allows manual override
       */
      .patch(
        '/me/timezone',
        async ({ auth, body, set }) => {
          if (!auth.isAuthenticated || !auth.identity) {
            set.status = 401;
            return { error: 'Not authenticated' };
          }

          const { timezone } = body;

          // Basic validation - ensure it's a valid IANA timezone
          try {
            Intl.DateTimeFormat(undefined, { timeZone: timezone });
          } catch {
            set.status = 400;
            return { error: 'Invalid timezone' };
          }

          const authIdentityRepo = new AuthIdentityRepository(dbClient);
          const updated = await authIdentityRepo.updateTimezone(
            auth.identity.id,
            timezone,
          );

          if (!updated) {
            set.status = 500;
            return { error: 'Failed to update timezone' };
          }

          return { success: true, timezone: updated.timezone };
        },
        {
          body: t.Object({
            timezone: t.String(),
          }),
          detail: {
            tags: ['Auth'],
            description: 'Update current user timezone',
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
      )
  );
}
