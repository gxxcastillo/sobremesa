/**
 * Intern Decision Repository
 *
 * Handles storage and retrieval of Intern classification decisions.
 */

import type { DatabaseClient } from '@sobremesa/database';
import type {
  InternDecision,
  InternDecisionType,
} from '@sobremesa/shared-types';

/**
 * Database row for intern_decisions
 */
interface InternDecisionRow {
  id: string;
  family_id: string;
  import_job_id: string;
  conversation_event_id: string;
  decision: string;
  reason: string | null;
  overridden: boolean;
  original_decision: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Maps database row to domain model
 */
function mapRowToDecision(row: InternDecisionRow): InternDecision {
  return {
    id: row.id,
    importJobId: row.import_job_id,
    conversationEventId: row.conversation_event_id,
    decision: row.decision as InternDecisionType,
    reason: row.reason,
    overridden: row.overridden,
    originalDecision: row.original_decision as InternDecisionType | null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Repository for Intern decisions.
 */
export class InternDecisionRepository {
  constructor(private dbClient: DatabaseClient) {}

  /**
   * Create or update a decision for a message.
   */
  async upsert(
    familyId: string,
    importJobId: string,
    conversationEventId: string,
    decision: InternDecisionType,
    reason: string | null,
  ): Promise<InternDecision> {
    const { data, error } = await this.dbClient
      .from('intern_decisions')
      .upsert(
        {
          family_id: familyId,
          import_job_id: importJobId,
          conversation_event_id: conversationEventId,
          decision,
          reason,
          overridden: false,
          original_decision: null,
        },
        {
          onConflict: 'import_job_id,conversation_event_id',
        },
      )
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to upsert intern decision: ${error.message}`);
    }

    return mapRowToDecision(data as InternDecisionRow);
  }

  /**
   * Bulk insert decisions for a job.
   */
  async bulkInsert(
    decisions: Array<{
      familyId: string;
      importJobId: string;
      conversationEventId: string;
      decision: InternDecisionType;
      reason: string | null;
    }>,
  ): Promise<void> {
    const rows = decisions.map((d) => ({
      family_id: d.familyId,
      import_job_id: d.importJobId,
      conversation_event_id: d.conversationEventId,
      decision: d.decision,
      reason: d.reason,
      overridden: false,
      original_decision: null,
    }));

    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await this.dbClient
        .from('intern_decisions')
        .insert(batch);

      if (error) {
        throw new Error(
          `Failed to bulk insert intern decisions at offset ${i}: ${error.message}`,
        );
      }
    }
  }

  /**
   * Get all decisions for a job.
   */
  async findByJobId(importJobId: string): Promise<InternDecision[]> {
    const { data, error } = await this.dbClient
      .from('intern_decisions')
      .select('*')
      .eq('import_job_id', importJobId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to get intern decisions: ${error.message}`);
    }

    return (data as InternDecisionRow[]).map(mapRowToDecision);
  }

  /**
   * Get decision for a specific event.
   */
  async findByEventId(
    importJobId: string,
    conversationEventId: string,
  ): Promise<InternDecision | null> {
    const { data, error } = await this.dbClient
      .from('intern_decisions')
      .select('*')
      .eq('import_job_id', importJobId)
      .eq('conversation_event_id', conversationEventId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw new Error(`Failed to get intern decision: ${error.message}`);
    }

    return mapRowToDecision(data as InternDecisionRow);
  }

  /**
   * Override a decision.
   */
  async override(
    importJobId: string,
    conversationEventId: string,
    newDecision: InternDecisionType,
  ): Promise<InternDecision> {
    // First get the current decision
    const current = await this.findByEventId(importJobId, conversationEventId);
    if (!current) {
      throw new Error('Decision not found');
    }

    const originalDecision = current.overridden
      ? current.originalDecision
      : current.decision;

    const { data, error } = await this.dbClient
      .from('intern_decisions')
      .update({
        decision: newDecision,
        overridden: true,
        original_decision: originalDecision,
      })
      .eq('import_job_id', importJobId)
      .eq('conversation_event_id', conversationEventId)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to override decision: ${error.message}`);
    }

    return mapRowToDecision(data as InternDecisionRow);
  }

  /**
   * Get counts by decision type for a job.
   */
  async getCounts(
    importJobId: string,
  ): Promise<{ toProcess: number; toSkip: number; overridden: number }> {
    const { data, error } = await this.dbClient
      .from('intern_decisions')
      .select('decision, overridden')
      .eq('import_job_id', importJobId);

    if (error) {
      throw new Error(`Failed to get decision counts: ${error.message}`);
    }

    const rows = data as Array<{ decision: string; overridden: boolean }>;

    return {
      toProcess: rows.filter((r) => r.decision === 'process').length,
      toSkip: rows.filter((r) => r.decision === 'skip').length,
      overridden: rows.filter((r) => r.overridden).length,
    };
  }

  /**
   * Delete all decisions for a job.
   */
  async deleteByJobId(importJobId: string): Promise<void> {
    const { error } = await this.dbClient
      .from('intern_decisions')
      .delete()
      .eq('import_job_id', importJobId);

    if (error) {
      throw new Error(`Failed to delete intern decisions: ${error.message}`);
    }
  }
}
