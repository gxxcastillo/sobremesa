/**
 * Admin Sync Handler
 *
 * Syncs Telegram chat admin status to the database for role determination.
 * Used to determine whether a user should get admin or member access when
 * they request a studio access pass.
 */

import type { Telegraf, Context } from 'telegraf';
import type { Update, ChatMember } from 'telegraf/types';
import { createLogger } from '@sobremesa/shared-utils';
import { FamilyRepository, IdentityRepository } from '@sobremesa/database';
import {
  TelegramChatAdminRepository,
  type TelegramAdminInfo,
} from '@sobremesa/auth';
import type pino from 'pino';

/**
 * Build display name from Telegram user
 */
function getDisplayName(user: {
  first_name: string;
  last_name?: string;
}): string {
  return user.last_name
    ? `${user.first_name} ${user.last_name}`
    : user.first_name;
}

/**
 * Check if a chat member status is admin or creator
 */
function isAdminStatus(status: ChatMember['status']): boolean {
  return status === 'administrator' || status === 'creator';
}

/**
 * Admin sync handler class
 */
export class AdminSyncHandler {
  private familyRepo: FamilyRepository;
  private chatAdminRepo: TelegramChatAdminRepository;
  private identityRepo: IdentityRepository;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.familyRepo = new FamilyRepository();
    this.chatAdminRepo = new TelegramChatAdminRepository();
    this.identityRepo = new IdentityRepository();
    this.logger = logger || createLogger({ name: 'admin-sync' });
  }

  /**
   * Sync all admins for a chat
   *
   * Fetches the current admin list from Telegram and updates the database.
   */
  async syncChatAdmins(
    bot: Telegraf,
    chatId: string,
    familyId: string,
  ): Promise<void> {
    try {
      // Fetch admins from Telegram
      const admins = await bot.telegram.getChatAdministrators(chatId);

      // Transform to our format
      const adminInfos: TelegramAdminInfo[] = admins.map((admin) => ({
        telegramUserId: admin.user.id,
        isAdmin: true,
        adminTitle: 'custom_title' in admin ? admin.custom_title : undefined,
        canManageChat:
          'can_manage_chat' in admin ? admin.can_manage_chat : false,
        canDeleteMessages:
          'can_delete_messages' in admin ? admin.can_delete_messages : false,
      }));

      // Sync to database
      await this.chatAdminRepo.syncChatAdmins(familyId, chatId, adminInfos);

      // Create global identities for all admins
      for (const admin of admins) {
        try {
          await this.identityRepo.findOrCreate(
            'telegram',
            String(admin.user.id),
            admin.user.username,
            getDisplayName(admin.user),
          );
        } catch (err) {
          this.logger.warn(
            { err, telegramUserId: admin.user.id },
            'Failed to create identity for admin',
          );
        }
      }

      this.logger.info(
        { chatId, familyId, adminCount: adminInfos.length },
        'Chat admins synced and identities created',
      );
    } catch (error) {
      this.logger.error(
        { error, chatId, familyId },
        'Failed to sync chat admins',
      );
    }
  }

  /**
   * Sync admins for all known families/chats on startup.
   * Creates identities for all admins.
   */
  async syncAllFamilies(bot: Telegraf): Promise<void> {
    try {
      const families = await this.familyRepo.findAllActive();

      this.logger.info(
        { familyCount: families.length },
        'Starting admin sync for all families',
      );

      for (const family of families) {
        if (family.chatId) {
          await this.syncChatAdmins(bot, family.chatId, family.id);
        }
      }

      this.logger.info('Admin sync completed for all families');
    } catch (error) {
      this.logger.error({ error }, 'Failed to sync all families');
    }
  }

  /**
   * Check if a user is admin in a chat (from cache or fresh fetch)
   */
  async isUserAdmin(
    bot: Telegraf,
    chatId: string,
    familyId: string,
    telegramUserId: number,
  ): Promise<boolean> {
    // First check cache
    const cached = await this.chatAdminRepo.findByFamilyChatUser(
      familyId,
      chatId,
      telegramUserId,
    );

    // If cached and recently synced (within 5 minutes), use cache
    if (cached) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (new Date(cached.lastSyncedAt) > fiveMinutesAgo) {
        return cached.isAdmin;
      }
    }

    // Fetch fresh admin status from Telegram
    try {
      const member = await bot.telegram.getChatMember(chatId, telegramUserId);
      const isAdmin = isAdminStatus(member.status);

      // Update cache
      await this.chatAdminRepo.upsertAdminStatus(familyId, chatId, {
        telegramUserId,
        isAdmin,
        adminTitle: 'custom_title' in member ? member.custom_title : undefined,
        canManageChat:
          'can_manage_chat' in member ? member.can_manage_chat : false,
        canDeleteMessages:
          'can_delete_messages' in member ? member.can_delete_messages : false,
      });

      return isAdmin;
    } catch (error) {
      this.logger.error(
        { error, chatId, telegramUserId },
        'Failed to fetch user admin status',
      );
      // Fall back to cached value if available
      return cached?.isAdmin ?? false;
    }
  }

  /**
   * Handle chat_member update events to keep admin status in sync
   */
  async handleChatMemberUpdate(
    ctx: Context<Update.ChatMemberUpdate>,
  ): Promise<void> {
    const chatId = String(ctx.chat?.id);

    // Find family for this chat
    const family = await this.familyRepo.findByChatId(chatId);
    if (!family) {
      return; // Not a registered family chat
    }

    const newMember = ctx.chatMember.new_chat_member;
    const telegramUserId = newMember.user.id;
    const isAdmin = isAdminStatus(newMember.status);

    // Update the user's admin status
    await this.chatAdminRepo.upsertAdminStatus(family.id, chatId, {
      telegramUserId,
      isAdmin,
      adminTitle:
        'custom_title' in newMember ? newMember.custom_title : undefined,
      canManageChat:
        'can_manage_chat' in newMember ? newMember.can_manage_chat : false,
      canDeleteMessages:
        'can_delete_messages' in newMember
          ? newMember.can_delete_messages
          : false,
    });

    this.logger.info(
      { chatId, familyId: family.id, telegramUserId, isAdmin },
      'User admin status updated',
    );
  }

  /**
   * Handle my_chat_member update (when bot is added/removed from chat)
   */
  async handleMyChatMemberUpdate(
    bot: Telegraf,
    ctx: Context<Update.MyChatMemberUpdate>,
  ): Promise<void> {
    const chatId = String(ctx.chat?.id);
    const newMember = ctx.myChatMember.new_chat_member;

    // Only sync when bot is added to a group
    if (newMember.status === 'member' || newMember.status === 'administrator') {
      // Find family for this chat
      const family = await this.familyRepo.findByChatId(chatId);
      if (family) {
        // Sync all admins when bot joins
        await this.syncChatAdmins(bot, chatId, family.id);
      }
    }
  }
}
