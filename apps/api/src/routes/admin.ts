/**
 * Admin Routes
 *
 * Super-admin-only management endpoints:
 * - GET /api/chats - List allowed chat IDs
 * - POST /api/chats - Authorize a chat ID
 * - DELETE /api/family/:familyId - Permanently delete a family and its data
 * - DELETE /api/chat/:chatId - Remove a chat ID from the allowlist
 */
import { Elysia, t } from 'elysia';
import {
  AllowedChatRepository,
  type DatabaseClient,
} from '@sobremesa/database';
import { requireSuperAdmin } from '@sobremesa/auth';

/**
 * Admin routes factory
 *
 * Every route in this file requires super admin access, so the guard is
 * applied once, to the whole file's Elysia instance.
 */
export function adminRoutes(dbClient: DatabaseClient) {
  return (
    new Elysia()
      .use(requireSuperAdmin)
      /**
       * GET /api/chats
       * List all allowed chats
       */
      .get(
        '/api/chats',
        async () => {
          const allowedChatRepo = new AllowedChatRepository(dbClient);
          return allowedChatRepo.list();
        },
        {
          detail: {
            tags: ['Admin'],
            description: 'List all allowed chat IDs (super admin only)',
          },
        },
      )
      /**
       * POST /api/chats
       * Authorize a chat ID
       */
      .post(
        '/api/chats',
        async ({ body }) => {
          const { chatId, note } = body;
          const allowedChatRepo = new AllowedChatRepository(dbClient);
          await allowedChatRepo.add(chatId, note);
          return { success: true };
        },
        {
          body: t.Object({
            chatId: t.String(),
            note: t.Optional(t.String()),
          }),
          detail: {
            tags: ['Admin'],
            description: 'Authorize a chat ID (super admin only)',
          },
        },
      )
      /**
       * DELETE /api/family/:familyId
       * Permanently delete a family and all its data
       */
      .delete(
        '/api/family/:familyId',
        async ({ params: { familyId }, set }) => {
          // Verify family exists
          const { data: family } = await dbClient
            .from('families')
            .select('id, name')
            .eq('id', familyId)
            .single();

          if (!family) {
            set.status = 404;
            return { error: 'Family not found' };
          }

          // Use the approved hard-delete function so immutable child-table
          // protections still block individual deletes but allow coherent
          // whole-family cascades.
          const { error } = await dbClient.rpc('delete_family_cascade', {
            p_family_id: familyId,
          });

          if (error) {
            console.error('[Admin] Failed to delete family:', error);
            set.status = 500;
            return { error: 'Failed to delete family' };
          }

          console.log(`[Admin] Deleted family: ${family.name} (${familyId})`);
          return { success: true, deletedFamilyId: familyId };
        },
        {
          params: t.Object({ familyId: t.String() }),
          detail: {
            tags: ['Admin'],
            description:
              'Permanently delete a family and all its data (super admin only)',
          },
        },
      )
      /**
       * DELETE /api/chat/:chatId
       * Remove a chat ID from the allowlist
       */
      .delete(
        '/api/chat/:chatId',
        async ({ params: { chatId } }) => {
          const allowedChatRepo = new AllowedChatRepository(dbClient);
          await allowedChatRepo.remove(chatId);
          return { success: true };
        },
        {
          params: t.Object({ chatId: t.String() }),
          detail: {
            tags: ['Admin'],
            description:
              'Remove a chat ID from the allowlist (super admin only)',
          },
        },
      )
  );
}
