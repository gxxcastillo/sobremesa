import type { DatabaseClient } from '../client';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Queue item for LLM evaluation.
 */
export interface LlmEvaluationQueueItem {
  id: string;
  familyId: string;
  evaluationType: 'claim_strength' | 'entity_match' | 'conflict_resolution';
  entityType: string;
  entityId: string;
  priority: number;
  context?: Record<string, unknown>;
  status: 'pending' | 'locked' | 'completed' | 'failed' | 'cancelled';
  lockedAt?: Date;
  lockedBy?: string;
  lockedUntil?: Date;
  attempts: number;
  lastError?: string;
  maxAttempts: number;
  completedAt?: Date;
  processingTimeMs?: number;
  result?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Queue statistics.
 */
export interface QueueStats {
  pending: number;
  locked: number;
  completed: number;
  failed: number;
  avgProcessingTimeMs: number;
}

/**
 * Repository for managing LLM evaluation queue.
 *
 * Supports:
 * - Prioritized queueing (high-stakes claims first)
 * - Distributed processing with optimistic locking
 * - Automatic lock expiration and retry logic
 * - Multiple evaluation types (claim strength, entity matching, conflict resolution)
 */
export class LlmEvaluationQueueRepository {
  protected client: DatabaseClient;
  protected tableName = 'llm_evaluation_queue';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Enqueue an item for LLM evaluation.
   */
  async enqueue(
    familyId: string,
    evaluationType: 'claim_strength' | 'entity_match' | 'conflict_resolution',
    entityType: string,
    entityId: string,
    options?: {
      priority?: number;
      context?: Record<string, unknown>;
      maxAttempts?: number;
    },
  ): Promise<LlmEvaluationQueueItem> {
    const record = {
      family_id: familyId,
      evaluation_type: evaluationType,
      entity_type: entityType,
      entity_id: entityId,
      priority: options?.priority ?? 0,
      context: options?.context,
      max_attempts: options?.maxAttempts ?? 3,
    };

    const { data, error } = await this.client
      .from(this.tableName)
      .insert(record)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to enqueue: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Acquire a batch of items to process (with optimistic locking).
   *
   * Uses lease-based locking with automatic expiration to handle worker failures.
   *
   * @param workerId - Unique identifier for this worker
   * @param batchSize - Number of items to acquire
   * @param lockDurationMinutes - How long to hold the lock (default 15 minutes)
   * @returns Array of locked queue items
   */
  async acquireBatch(
    workerId: string,
    batchSize = 10,
    lockDurationMinutes = 15,
  ): Promise<LlmEvaluationQueueItem[]> {
    const lockUntil = new Date();
    lockUntil.setMinutes(lockUntil.getMinutes() + lockDurationMinutes);

    // Fetch pending items ordered by priority (high first) and age (old first)
    const { data: pending, error: fetchError } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('status', 'pending')
      .order('priority', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (fetchError) {
      throw new Error(`Failed to fetch queue: ${fetchError.message}`);
    }

    if (!pending || pending.length === 0) {
      return [];
    }

    const ids = pending.map((item) => item.id);

    // Atomically lock items (only lock if still pending - optimistic concurrency)
    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        status: 'locked',
        locked_at: new Date().toISOString(),
        locked_by: workerId,
        locked_until: lockUntil.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', ids)
      .eq('status', 'pending') // Critical: only lock if still pending
      .select();

    if (error) {
      throw new Error(`Failed to lock items: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Mark item as completed with result.
   */
  async complete(
    queueItemId: string,
    result: Record<string, unknown>,
    processingTimeMs: number,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
        processing_time_ms: processingTimeMs,
        updated_at: new Date().toISOString(),
        // Clear lock fields
        locked_at: null,
        locked_by: null,
        locked_until: null,
      })
      .eq('id', queueItemId);

    if (error) {
      throw new Error(`Failed to complete: ${error.message}`);
    }
  }

  /**
   * Mark item as failed with error.
   * If max attempts reached, marks as permanently failed.
   * Otherwise, returns to pending for retry.
   */
  async fail(queueItemId: string, errorMessage: string): Promise<void> {
    // Get current state
    const { data: current, error: fetchError } = await this.client
      .from(this.tableName)
      .select('attempts, max_attempts')
      .eq('id', queueItemId)
      .single();

    if (fetchError) {
      throw new Error(`Failed to fetch item: ${fetchError.message}`);
    }

    const newAttempts = ((current?.attempts as number) ?? 0) + 1;
    const maxAttempts = (current?.max_attempts as number) ?? 3;

    // If max attempts reached, mark as failed permanently
    const newStatus = newAttempts >= maxAttempts ? 'failed' : 'pending';

    const { error } = await this.client
      .from(this.tableName)
      .update({
        status: newStatus,
        attempts: newAttempts,
        last_error: errorMessage,
        updated_at: new Date().toISOString(),
        // Release lock
        locked_at: null,
        locked_by: null,
        locked_until: null,
      })
      .eq('id', queueItemId);

    if (error) {
      throw new Error(`Failed to record failure: ${error.message}`);
    }
  }

  /**
   * Clean up expired locks.
   * Call this periodically or use database function.
   *
   * @returns Number of locks released
   */
  async cleanupExpiredLocks(): Promise<number> {
    const { data, error } = await this.client.rpc(
      'cleanup_expired_evaluation_locks',
    );

    if (error) {
      throw new Error(`Failed to cleanup locks: ${error.message}`);
    }

    return (data as number) ?? 0;
  }

  /**
   * Get queue statistics.
   */
  async getStats(familyId?: string): Promise<QueueStats> {
    let query = this.client
      .from(this.tableName)
      .select('status, processing_time_ms');

    if (familyId) {
      query = query.eq('family_id', familyId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get stats: ${error.message}`);
    }

    const stats = {
      pending: 0,
      locked: 0,
      completed: 0,
      failed: 0,
      totalProcessingTime: 0,
      completedCount: 0,
    };

    for (const row of data || []) {
      const status = row.status as keyof typeof stats;
      if (status in stats && typeof stats[status] === 'number') {
        (stats[status] as number)++;
      }

      if (row.status === 'completed' && row.processing_time_ms) {
        stats.totalProcessingTime += row.processing_time_ms as number;
        stats.completedCount++;
      }
    }

    return {
      pending: stats.pending,
      locked: stats.locked,
      completed: stats.completed,
      failed: stats.failed,
      avgProcessingTimeMs:
        stats.completedCount > 0
          ? stats.totalProcessingTime / stats.completedCount
          : 0,
    };
  }

  /**
   * Cancel a pending or locked item.
   */
  async cancel(queueItemId: string): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({
        status: 'cancelled',
        updated_at: new Date().toISOString(),
        // Release lock if locked
        locked_at: null,
        locked_by: null,
        locked_until: null,
      })
      .eq('id', queueItemId)
      .in('status', ['pending', 'locked']);

    if (error) {
      throw new Error(`Failed to cancel: ${error.message}`);
    }
  }

  /**
   * Find queue items by entity.
   * Useful for batching evaluations of related items.
   */
  async findByEntity(
    entityType: string,
    entityId: string,
    status?: 'pending' | 'locked' | 'completed' | 'failed',
  ): Promise<LlmEvaluationQueueItem[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to find by entity: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Get failed items for manual review or retry.
   */
  async getFailedItems(familyId?: string): Promise<LlmEvaluationQueueItem[]> {
    let query = this.client
      .from(this.tableName)
      .select('*')
      .eq('status', 'failed')
      .order('updated_at', { ascending: false });

    if (familyId) {
      query = query.eq('family_id', familyId);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to get failed items: ${error.message}`);
    }

    return (data || []).map((row) => this.mapFromDb(row));
  }

  /**
   * Retry a failed item by resetting it to pending.
   */
  async retry(queueItemId: string, resetAttempts = false): Promise<void> {
    const updates: Record<string, unknown> = {
      status: 'pending',
      last_error: null,
      updated_at: new Date().toISOString(),
    };

    if (resetAttempts) {
      updates.attempts = 0;
    }

    const { error } = await this.client
      .from(this.tableName)
      .update(updates)
      .eq('id', queueItemId)
      .eq('status', 'failed');

    if (error) {
      throw new Error(`Failed to retry: ${error.message}`);
    }
  }

  private mapFromDb(row: Record<string, unknown>): LlmEvaluationQueueItem {
    return mapRowToCamelCase<LlmEvaluationQueueItem>(row);
  }
}
