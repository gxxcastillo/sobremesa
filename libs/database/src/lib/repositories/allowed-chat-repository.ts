import { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from '../client.js';

/**
 * Repository for allowed chats whitelist.
 */
export class AllowedChatRepository {
  private client: SupabaseClient;
  private tableName = 'allowed_chats';

  constructor(client?: SupabaseClient) {
    this.client = client || getServiceClient();
  }

  /**
   * Check if a chat ID is allowed.
   */
  async isAllowed(chatId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('chat_id')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to check allowed chat: ${error.message}`);
    }

    return data !== null;
  }

  /**
   * Add a chat to the whitelist.
   */
  async add(chatId: string, note?: string, source = 'telegram'): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .insert({ chat_id: chatId, source, note });

    if (error) {
      throw new Error(`Failed to add allowed chat: ${error.message}`);
    }
  }

  /**
   * Remove a chat from the whitelist.
   */
  async remove(chatId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('chat_id', chatId);

    if (error) {
      throw new Error(`Failed to remove allowed chat: ${error.message}`);
    }
  }

  /**
   * List all allowed chats.
   */
  async list(): Promise<Array<{ chatId: string; source: string; note: string | null }>> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('chat_id, source, note')
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to list allowed chats: ${error.message}`);
    }

    return (data || []).map((row) => ({
      chatId: row.chat_id,
      source: row.source,
      note: row.note,
    }));
  }
}
