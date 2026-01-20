/**
 * TelegramChatAdmin Repository
 *
 * Manages telegram_chat_admins table operations for caching
 * Telegram chat admin status
 */

import { getServiceClient, mapRowToCamelCase } from '@sobremesa/database';
import type { TelegramChatAdmin } from '../types';

export interface TelegramAdminInfo {
  telegramUserId: number;
  isAdmin: boolean;
  adminTitle?: string;
  canManageChat?: boolean;
  canDeleteMessages?: boolean;
}

export class TelegramChatAdminRepository {
  /**
   * Find admin record by family, chat, and user
   */
  async findByFamilyChatUser(
    familyId: string,
    chatId: string,
    telegramUserId: number,
  ): Promise<TelegramChatAdmin | null> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('telegram_chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('chat_id', chatId)
      .eq('telegram_user_id', telegramUserId)
      .single();

    if (error || !data) {
      return null;
    }

    return mapRowToCamelCase(data) as TelegramChatAdmin;
  }

  /**
   * Find all admins for a family
   */
  async findByFamily(familyId: string): Promise<TelegramChatAdmin[]> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('telegram_chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('is_admin', true)
      .order('last_synced_at', { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map((row) => mapRowToCamelCase(row) as TelegramChatAdmin);
  }

  /**
   * Find all admins for a chat
   */
  async findByChat(
    familyId: string,
    chatId: string,
  ): Promise<TelegramChatAdmin[]> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('telegram_chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('chat_id', chatId)
      .eq('is_admin', true)
      .order('last_synced_at', { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map((row) => mapRowToCamelCase(row) as TelegramChatAdmin);
  }

  /**
   * Check if user is admin of any family chat
   */
  async isAdminOfFamily(
    familyId: string,
    telegramUserId: number,
  ): Promise<boolean> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('telegram_chat_admins')
      .select('id')
      .eq('family_id', familyId)
      .eq('telegram_user_id', telegramUserId)
      .eq('is_admin', true)
      .limit(1);

    if (error || !data) {
      return false;
    }

    return data.length > 0;
  }

  /**
   * Upsert admin status for a user in a chat
   */
  async upsertAdminStatus(
    familyId: string,
    chatId: string,
    adminInfo: TelegramAdminInfo,
  ): Promise<TelegramChatAdmin> {
    const client = getServiceClient();

    const { data, error } = await client
      .from('telegram_chat_admins')
      .upsert(
        {
          family_id: familyId,
          chat_id: chatId,
          telegram_user_id: adminInfo.telegramUserId,
          is_admin: adminInfo.isAdmin,
          admin_title: adminInfo.adminTitle || null,
          can_manage_chat: adminInfo.canManageChat || false,
          can_delete_messages: adminInfo.canDeleteMessages || false,
          last_synced_at: new Date().toISOString(),
        },
        {
          onConflict: 'family_id,chat_id,telegram_user_id',
        },
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to upsert admin status: ${error.message}`);
    }

    return mapRowToCamelCase(data) as TelegramChatAdmin;
  }

  /**
   * Bulk sync admin statuses for a chat
   * This replaces all admin records for the chat with the new list
   */
  async syncChatAdmins(
    familyId: string,
    chatId: string,
    admins: TelegramAdminInfo[],
  ): Promise<void> {
    const client = getServiceClient();

    // Get all current users in this chat
    const { data: currentRecords } = await client
      .from('telegram_chat_admins')
      .select('telegram_user_id')
      .eq('family_id', familyId)
      .eq('chat_id', chatId);

    const currentUserIds = new Set(
      currentRecords?.map((r) => r.telegram_user_id) || [],
    );
    const newUserIds = new Set(admins.map((a) => a.telegramUserId));

    // Upsert all admins from the new list
    for (const admin of admins) {
      await this.upsertAdminStatus(familyId, chatId, admin);
    }

    // Mark users not in new list as non-admin
    for (const userId of currentUserIds) {
      if (!newUserIds.has(userId)) {
        await this.upsertAdminStatus(familyId, chatId, {
          telegramUserId: userId,
          isAdmin: false,
        });
      }
    }
  }

  /**
   * Delete all records for a family
   */
  async deleteByFamily(familyId: string): Promise<boolean> {
    const client = getServiceClient();

    const { error } = await client
      .from('telegram_chat_admins')
      .delete()
      .eq('family_id', familyId);

    return !error;
  }

  /**
   * Delete all records for a chat
   */
  async deleteByChat(familyId: string, chatId: string): Promise<boolean> {
    const client = getServiceClient();

    const { error } = await client
      .from('telegram_chat_admins')
      .delete()
      .eq('family_id', familyId)
      .eq('chat_id', chatId);

    return !error;
  }
}
