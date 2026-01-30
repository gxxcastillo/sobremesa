import type { DatabaseClient } from '@sobremesa/database';
/**
 * TelegramChatAdmin Repository
 *
 * Manages chat_admins table operations for caching
 * Telegram chat admin status (queries with source='telegram')
 */

import { mapRowToCamelCase } from '@sobremesa/database';
import type { TelegramChatAdmin } from '../types';

export interface TelegramAdminInfo {
  telegramUserId: number;
  isAdmin: boolean;
  adminTitle?: string;
  canManageChat?: boolean;
  canDeleteMessages?: boolean;
}

export class TelegramChatAdminRepository {
  private client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Find admin record by family, chat, and user
   */
  async findByFamilyChatUser(
    familyId: string,
    chatId: string,
    telegramUserId: number,
  ): Promise<TelegramChatAdmin | null> {
    const client = this.client;

    const { data, error } = await client
      .from('chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('chat_id', chatId)
      .eq('provider_user_id', telegramUserId.toString())
      .single();

    if (error || !data) {
      return null;
    }

    return this.mapToTelegramChatAdmin(data);
  }

  /**
   * Find all admins for a family
   */
  async findByFamily(familyId: string): Promise<TelegramChatAdmin[]> {
    const client = this.client;

    const { data, error } = await client
      .from('chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('is_admin', true)
      .order('last_synced_at', { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map((row) => this.mapToTelegramChatAdmin(row));
  }

  /**
   * Find all admins for a chat
   */
  async findByChat(
    familyId: string,
    chatId: string,
  ): Promise<TelegramChatAdmin[]> {
    const client = this.client;

    const { data, error } = await client
      .from('chat_admins')
      .select('*')
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('chat_id', chatId)
      .eq('is_admin', true)
      .order('last_synced_at', { ascending: false });

    if (error || !data) {
      return [];
    }

    return data.map((row) => this.mapToTelegramChatAdmin(row));
  }

  /**
   * Check if user is admin of any family chat
   */
  async isAdminOfFamily(
    familyId: string,
    telegramUserId: number,
  ): Promise<boolean> {
    const client = this.client;

    const { data, error } = await client
      .from('chat_admins')
      .select('id')
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('provider_user_id', telegramUserId.toString())
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
    const client = this.client;

    const permissions: Record<string, boolean> = {};
    if (adminInfo.canManageChat !== undefined) {
      permissions.can_manage_chat = adminInfo.canManageChat;
    }
    if (adminInfo.canDeleteMessages !== undefined) {
      permissions.can_delete_messages = adminInfo.canDeleteMessages;
    }

    const { data, error } = await client
      .from('chat_admins')
      .upsert(
        {
          family_id: familyId,
          source: 'telegram',
          chat_id: chatId,
          provider_user_id: adminInfo.telegramUserId.toString(),
          is_admin: adminInfo.isAdmin,
          admin_title: adminInfo.adminTitle || null,
          permissions,
          last_synced_at: new Date().toISOString(),
        },
        {
          onConflict: 'family_id,source,chat_id,provider_user_id',
        },
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to upsert admin status: ${error.message}`);
    }

    return this.mapToTelegramChatAdmin(data);
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
    const client = this.client;

    // Get all current users in this chat
    const { data: currentRecords } = await client
      .from('chat_admins')
      .select('provider_user_id')
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('chat_id', chatId);

    const currentUserIds = new Set(
      currentRecords?.map((r) => parseInt(r.provider_user_id, 10)) || [],
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
    const client = this.client;

    const { error } = await client
      .from('chat_admins')
      .delete()
      .eq('family_id', familyId)
      .eq('source', 'telegram');

    return !error;
  }

  /**
   * Delete all records for a chat
   */
  async deleteByChat(familyId: string, chatId: string): Promise<boolean> {
    const client = this.client;

    const { error } = await client
      .from('chat_admins')
      .delete()
      .eq('family_id', familyId)
      .eq('source', 'telegram')
      .eq('chat_id', chatId);

    return !error;
  }

  /**
   * Map database row to TelegramChatAdmin type
   */ // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapToTelegramChatAdmin(row: any): TelegramChatAdmin {
    const mapped = mapRowToCamelCase<TelegramChatAdmin>(row);
    const perms = mapped.permissions || {};
    return {
      ...mapped,
      telegramUserId: parseInt(mapped.providerUserId, 10),
      canManageChat: perms.can_manage_chat || false,
      canDeleteMessages: perms.can_delete_messages || false,
    } as TelegramChatAdmin;
  }
}
