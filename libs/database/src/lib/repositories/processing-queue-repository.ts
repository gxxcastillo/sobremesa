import type { DatabaseClient } from '../client';
import type {
  QueueItem,
  QueueItemStatus,
  EnqueueOptions,
} from '@sobremesa/shared-types';
import { QueuePriority } from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

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
   * Dequeue the next ready item from any family for processing. The
   * database function enforces one in-flight item per family, so this
   * never returns an item for a family that already has one processing.
   */
  async dequeueAny(
    workerId: string,
    lockTimeoutMs = 300000,
  ): Promise<QueueItem | null> {
    const { data, error } = await this.client.rpc(
      'dequeue_processing_queue_item',
      {
        p_worker_id: workerId,
        p_lock_timeout_ms: lockTimeoutMs,
      },
    );

    if (error) {
      throw new Error(`Failed to dequeue queue item: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return row ? mapRowToCamelCase<QueueItem>(row) : null;
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

    const { error } = await this.client
      .from(this.tableName)
      .update({
        status,
        attempts,
        last_error: errorMessage,
        locked_at: null,
        locked_by: null,
      })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(`Failed to mark queue item as failed: ${error.message}`);
    }

    return status;
  }

  /**
   * Return dead-lettered items for a family (status='error'), newest first.
   * Paginate with `offset` once a family has more than fits in one `limit`
   * page — use `getErrorCount(familyId)` for the true total count (cheaper
   * than `getStats`, which counts every status).
   */
  async getErrors(
    familyId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<QueueItem[]> {
    const limit = Math.max(0, options?.limit ?? 100);
    const offset = Math.max(0, options?.offset ?? 0);

    // A zero-length page has no valid `.range()` — `.range(offset, offset - 1)`
    // is an inverted range Postgres/PostgREST doesn't accept. Short-circuit
    // rather than let it reach the DB as an error.
    if (limit === 0) {
      return [];
    }

    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('status', 'error')
      .order('queued_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to fetch error queue items: ${error.message}`);
    }

    return (data || []).map((row) => mapRowToCamelCase<QueueItem>(row));
  }

  /**
   * Count dead-lettered items for a family (status='error') — a single
   * `count: 'exact'` query, cheaper than `getStats` when only this one
   * status is needed (e.g. reporting the true total behind `getErrors`'s
   * paginated page).
   */
  async getErrorCount(familyId: string): Promise<number> {
    const { count, error } = await this.client
      .from(this.tableName)
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('status', 'error');

    if (error) {
      throw new Error(`Failed to count error queue items: ${error.message}`);
    }

    return count || 0;
  }

  /**
   * Reset a dead-lettered item back to 'queued' so it will be retried.
   * Only operates on items currently in 'error' status.
   *
   * Returns `true` if a matching error-status item was found and reset,
   * `false` if there was no such item (not found, or not in 'error' status —
   * the caller can't tell which, matching the 404 the API route reports
   * either way). Throws only on a genuine database error.
   */
  async requeue(familyId: string, id: string): Promise<boolean> {
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

    return Boolean(data?.length);
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

    const counts = await Promise.all(
      statuses.map(async (status) => {
        const { count, error } = await this.client
          .from(this.tableName)
          .select('*', { count: 'exact', head: true })
          .eq('family_id', familyId)
          .eq('status', status);

        if (error) {
          throw new Error(`Failed to get queue stats: ${error.message}`);
        }

        return [status, count || 0] as const;
      }),
    );

    return Object.fromEntries(counts) as {
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
