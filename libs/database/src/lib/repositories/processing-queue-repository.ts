import type { DatabaseClient } from '../client';
import type {
  QueueItem,
  QueueItemStatus,
  EnqueueOptions,
} from '@sobremesa/shared-types';
import { QueuePriority } from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

export const REQUEUE_NOT_FOUND_ERROR =
  'Queue item not found or not in error state';

/**
 * Repository for the processing queue.
 * Manages ordered, retryable message processing.
 */
export class ProcessingQueueRepository {
  private client: DatabaseClient;
  private tableName = 'processing_queue';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Enqueue a conversation event for processing.
   * @param familyId - The family ID
   * @param conversationEventId - The conversation event ID
   * @param options - Enqueue options (priority, processAfter)
   */
  async enqueue(
    familyId: string,
    conversationEventId: string,
    options: EnqueueOptions = {},
  ): Promise<QueueItem> {
    const priority = options.priority ?? QueuePriority.NORMAL;
    const processAfter =
      options.processAfter?.toISOString() ?? new Date().toISOString();

    const { data, error } = await this.client
      .from(this.tableName)
      .insert({
        family_id: familyId,
        conversation_event_id: conversationEventId,
        status: 'queued',
        attempts: 0,
        priority,
        process_after: processAfter,
      })
      .select()
      .single();

    if (error) {
      // Handle unique constraint violation (already queued)
      if (error.code === '23505') {
        const existing = await this.findByEventId(
          familyId,
          conversationEventId,
        );
        if (existing) return existing;
      }
      throw new Error(`Failed to enqueue event: ${error.message}`);
    }

    return mapRowToCamelCase<QueueItem>(data);
  }

  /**
   * Find a queue item by conversation event ID.
   */
  async findByEventId(
    familyId: string,
    conversationEventId: string,
  ): Promise<QueueItem | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('conversation_event_id', conversationEventId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find queue item: ${error.message}`);
    }

    return mapRowToCamelCase<QueueItem>(data);
  }

  /**
   * Dequeue the next item for processing.
   * Implements locking to prevent duplicate processing.
   * Orders by priority (ascending, lower = higher priority), then by queued_at.
   * Only returns items where process_after <= NOW (for debouncing support).
   */
  async dequeue(
    familyId: string,
    workerId: string,
    lockTimeoutMs = 300000,
  ): Promise<QueueItem | null> {
    const lockExpiry = new Date(Date.now() - lockTimeoutMs).toISOString();
    const now = new Date().toISOString();

    // Find the next available item (respecting process_after for debouncing)
    const { data: queuedItems, error: selectError } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('status', 'queued')
      .lte('process_after', now)
      .order('priority', { ascending: true })
      .order('queued_at', { ascending: true })
      .limit(1);

    if (selectError) {
      throw new Error(`Failed to find queue item: ${selectError.message}`);
    }

    // If no queued items ready, try stale processing items
    let itemToLock = queuedItems?.[0];
    if (!itemToLock) {
      const { data: staleItems, error: staleError } = await this.client
        .from(this.tableName)
        .select('*')
        .eq('family_id', familyId)
        .eq('status', 'processing')
        .lt('locked_at', lockExpiry)
        .lte('process_after', now)
        .order('priority', { ascending: true })
        .order('queued_at', { ascending: true })
        .limit(1);

      if (staleError) {
        throw new Error(
          `Failed to find stale queue item: ${staleError.message}`,
        );
      }
      itemToLock = staleItems?.[0];
    }

    if (!itemToLock) {
      return null;
    }

    // Lock the item
    const { data: lockedItems, error: updateError } = await this.client
      .from(this.tableName)
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
      })
      .eq('id', itemToLock.id)
      .eq('status', itemToLock.status)
      .select();

    if (updateError) {
      throw new Error(`Failed to lock queue item: ${updateError.message}`);
    }

    // If another worker grabbed it first, retry
    if (!lockedItems?.[0]) {
      return this.dequeue(familyId, workerId, lockTimeoutMs);
    }

    return mapRowToCamelCase<QueueItem>(lockedItems[0]);
  }

  /**
   * Dequeue the next item from any family for processing.
   * Used for multi-family queue processing.
   * Orders by priority (ascending, lower = higher priority), then by queued_at.
   * Only returns items where process_after <= NOW (for debouncing support).
   */
  async dequeueAny(
    workerId: string,
    lockTimeoutMs = 300000,
  ): Promise<QueueItem | null> {
    const lockExpiry = new Date(Date.now() - lockTimeoutMs).toISOString();
    const now = new Date().toISOString();

    // Find queued items ready for processing (respecting process_after)
    const { data: queuedItems, error: selectError } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('status', 'queued')
      .lte('process_after', now)
      .order('priority', { ascending: true })
      .order('queued_at', { ascending: true })
      .limit(1);

    if (selectError) {
      throw new Error(`Failed to find queue item: ${selectError.message}`);
    }

    // If no queued items ready, try stale processing items
    let itemToLock = queuedItems?.[0];
    if (!itemToLock) {
      const { data: staleItems, error: staleError } = await this.client
        .from(this.tableName)
        .select('*')
        .eq('status', 'processing')
        .lt('locked_at', lockExpiry)
        .lte('process_after', now)
        .order('priority', { ascending: true })
        .order('queued_at', { ascending: true })
        .limit(1);

      if (staleError) {
        throw new Error(
          `Failed to find stale queue item: ${staleError.message}`,
        );
      }
      itemToLock = staleItems?.[0];
    }

    if (!itemToLock) {
      return null;
    }

    // Lock the item
    const { data: lockedItems, error: updateError } = await this.client
      .from(this.tableName)
      .update({
        status: 'processing',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
      })
      .eq('id', itemToLock.id)
      .eq('status', itemToLock.status)
      .select();

    if (updateError) {
      throw new Error(`Failed to lock queue item: ${updateError.message}`);
    }

    // If another worker grabbed it first, retry
    if (!lockedItems?.[0]) {
      return this.dequeueAny(workerId, lockTimeoutMs);
    }

    return mapRowToCamelCase<QueueItem>(lockedItems[0]);
  }

  /**
   * Mark an item as completed.
   */
  async complete(familyId: string, id: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({ status: 'done' })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to complete queue item: ${error.message}`);
    }
  }

  /**
   * Mark an item as failed. Returns the resulting status so callers can detect
   * when an item transitions to the dead-letter state ('error').
   */
  async fail(
    familyId: string,
    id: string,
    errorMessage: string,
    maxRetries = 3,
  ): Promise<QueueItemStatus> {
    // First get current attempts
    const { data: current, error: fetchError } = await this.client
      .from(this.tableName)
      .select('attempts')
      .eq('family_id', familyId)
      .eq('id', id)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch queue item: ${fetchError.message}`);
    }

    const attempts = (current?.attempts || 0) + 1;
    const status: QueueItemStatus = attempts >= maxRetries ? 'error' : 'queued';

    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        status,
        attempts,
        last_error: errorMessage,
        locked_at: null,
        locked_by: null,
      })
      .eq('family_id', familyId)
      .eq('id', id)
      .select('id');

    if (error) {
      throw new Error(`Failed to mark queue item as failed: ${error.message}`);
    }

    if (!data?.length) {
      throw new Error(`Queue item not found: ${id}`);
    }

    return status;
  }

  /**
   * Return all dead-lettered items for a family (status='error').
   */
  async getErrors(familyId: string): Promise<QueueItem[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('status', 'error')
      .order('queued_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch error queue items: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<QueueItem>(row));
  }

  /**
   * Reset a dead-lettered item back to 'queued' so it will be retried.
   * Only operates on items currently in 'error' status.
   */
  async requeue(familyId: string, id: string): Promise<void> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        status: 'queued',
        attempts: 0,
        last_error: null,
        locked_at: null,
        locked_by: null,
        queued_at: new Date().toISOString(),
      })
      .eq('family_id', familyId)
      .eq('id', id)
      .eq('status', 'error')
      .select('id');

    if (error) {
      throw new Error(`Failed to requeue item: ${error.message}`);
    }

    if (!data?.length) {
      throw new Error(`${REQUEUE_NOT_FOUND_ERROR}: ${id}`);
    }
  }

  /**
   * Get queue stats for a family.
   */
  async getStats(familyId: string): Promise<{
    queued: number;
    processing: number;
    done: number;
    error: number;
  }> {
    const statuses: QueueItemStatus[] = [
      'queued',
      'processing',
      'done',
      'error',
    ];
    const stats: Record<string, number> = {};

    for (const status of statuses) {
      const { count, error } = await this.client
        .from(this.tableName)
        .select('*', { count: 'exact', head: true })
        .eq('family_id', familyId)
        .eq('status', status);

      if (error) {
        throw new Error(`Failed to get queue stats: ${error.message}`);
      }

      stats[status] = count || 0;
    }

    return stats as {
      queued: number;
      processing: number;
      done: number;
      error: number;
    };
  }

  /**
   * Clear completed items older than a threshold.
   */
  async clearCompleted(familyId: string, olderThanDays = 7): Promise<number> {
    const threshold = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data, error } = await this.client
      .from(this.tableName)
      .delete()
      .eq('family_id', familyId)
      .eq('status', 'done')
      .lt('queued_at', threshold)
      .select('id');

    if (error) {
      throw new Error(`Failed to clear completed items: ${error.message}`);
    }

    return data?.length || 0;
  }

  /**
   * Find all pending queue items for given event IDs.
   * Useful for consolidating related events (e.g., multiple join events).
   */
  async findPendingByEventIds(
    familyId: string,
    conversationEventIds: string[],
  ): Promise<QueueItem[]> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .in('conversation_event_id', conversationEventIds)
      .eq('status', 'queued')
      .order('queued_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to find pending items: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<QueueItem>(row));
  }

  /**
   * Mark multiple items as completed in a single operation.
   */
  async completeMany(familyId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const { error } = await this.client
      .from(this.tableName)
      .update({ status: 'done' })
      .eq('family_id', familyId)
      .in('id', ids);

    if (error) {
      throw new Error(`Failed to complete queue items: ${error.message}`);
    }
  }
}
