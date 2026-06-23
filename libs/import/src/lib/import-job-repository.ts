/**
 * Import Job Repository
 *
 * Manages import job records in the database.
 */

import type { DatabaseClient } from '@sobremesa/database';
import type {
  ImportJob,
  ImportJobStatus,
  ImportConfig,
} from '@sobremesa/shared-types';

/**
 * Create options for import job
 */
export interface CreateImportJobOptions {
  createdBy: string;
  source: 'whatsapp' | 'telegram' | 'other';
  config: ImportConfig;
  rawFileContent: string;
  messageCount: number;
}

/**
 * Update options for import job
 */
export interface UpdateImportJobOptions {
  status?: ImportJobStatus;
  progress?: {
    current: number;
    total: number;
    stage: string;
    lastProcessedEventId?: string;
  };
  batchIds?: string[];
  familyId?: string;
  conversationId?: string;
  error?: string;
  completedAt?: Date;
}

/**
 * Repository for import jobs.
 */
export class ImportJobRepository {
  constructor(private client: DatabaseClient) {}

  /**
   * Create a new import job.
   */
  async create(options: CreateImportJobOptions): Promise<ImportJob> {
    const { data, error } = await this.client
      .from('import_jobs')
      .insert({
        created_by: options.createdBy,
        source: options.source,
        config: options.config,
        progress: {
          current: 0,
          total: options.messageCount,
          stage: 'pending',
        },
        metadata: {
          rawFileContent: options.rawFileContent,
        },
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create import job: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Find job by ID.
   */
  async findById(jobId: string): Promise<ImportJob | null> {
    const { data, error } = await this.client
      .from('import_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find import job: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Update job status and progress.
   */
  async update(
    jobId: string,
    updates: UpdateImportJobOptions,
  ): Promise<ImportJob> {
    const updateData: Record<string, unknown> = {};

    if (updates.status) {
      updateData.status = updates.status;
    }
    if (updates.progress) {
      updateData.progress = updates.progress;
    }
    if (updates.batchIds) {
      updateData.batch_ids = updates.batchIds;
    }
    if (updates.familyId) {
      updateData.family_id = updates.familyId;
    }
    if (updates.conversationId) {
      updateData.conversation_id = updates.conversationId;
    }
    if (updates.error !== undefined) {
      updateData.error = updates.error;
    }
    if (updates.completedAt) {
      updateData.completed_at = updates.completedAt.toISOString();
    }

    const { data, error } = await this.client
      .from('import_jobs')
      .update(updateData)
      .eq('id', jobId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update import job: ${error.message}`);
    }

    return this.mapFromDb(data);
  }

  /**
   * Atomically transition a job from one of the expected statuses to a new status.
   * Returns the updated job, or null if the job was not in an expected status
   * (i.e. another request already transitioned it).
   */
  async transitionStatus(
    jobId: string,
    expectedStatuses: ImportJobStatus[],
    newStatus: ImportJobStatus,
    progress?: UpdateImportJobOptions['progress'],
  ): Promise<ImportJob | null> {
    const updateData: Record<string, unknown> = { status: newStatus };
    if (progress) {
      updateData.progress = progress;
    }

    let query = this.client
      .from('import_jobs')
      .update(updateData)
      .eq('id', jobId);

    // Supabase .in() requires an array of values
    query = query.in('status', expectedStatuses);

    const { data, error } = await query.select().maybeSingle();

    if (error) {
      throw new Error(
        `Failed to transition import job status: ${error.message}`,
      );
    }

    // null means the WHERE didn't match — another caller already transitioned
    return data ? this.mapFromDb(data) : null;
  }

  /**
   * Find active jobs (for cleanup/resume).
   */
  async findActive(): Promise<ImportJob[]> {
    const { data, error } = await this.client
      .from('import_jobs')
      .select('*')
      .not('status', 'in', '("complete","failed","cancelled")')
      .order('started_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to find active import jobs: ${error.message}`);
    }

    return (data || []).map(this.mapFromDb);
  }

  /**
   * Map database row to ImportJob.
   */
  private mapFromDb(row: Record<string, unknown>): ImportJob {
    return {
      id: row.id as string,
      createdBy: row.created_by as string,
      status: row.status as ImportJobStatus,
      source: row.source as 'whatsapp' | 'telegram' | 'other',
      config: row.config as ImportConfig,
      progress: row.progress as ImportJob['progress'],
      batchIds: (row.batch_ids as string[]) || [],
      familyId: row.family_id as string | undefined,
      conversationId: row.conversation_id as string | undefined,
      error: row.error as string | undefined,
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at
        ? new Date(row.completed_at as string)
        : undefined,
      metadata: row.metadata as ImportJob['metadata'],
    };
  }
}
