/**
 * Import Processor
 *
 * Handles the full import workflow:
 * 1. Create family
 * 2. Create identities for participants
 * 3. Submit to Anthropic Batch API
 * 4. Process batch results
 * 5. Hydrate database with Registrar
 */

import type { DatabaseClient } from '@sobremesa/database';
import {
  FamilyRepository,
  EventLogRepository,
  PersonRepository,
} from '@sobremesa/database';
import { FamilyAccessRepository } from '@sobremesa/auth';
// For future Batch API integration
// import { RegistrarAgent } from '@sobremesa/agents-registrar';
import type { ImportJob } from '@sobremesa/shared-types';
import {
  parseWhatsAppExport,
  parseTimestampWithTimezone,
} from '@sobremesa/import-utils';
import { ImportJobRepository } from './import-job-repository';
import { createLogger } from '@sobremesa/shared-utils';
import type pino from 'pino';

/**
 * Thrown when a job is cancelled mid-processing.
 */
class CancellationError extends Error {
  constructor(jobId: string) {
    super(`Import job ${jobId} was cancelled`);
    this.name = 'CancellationError';
  }
}

/**
 * Options for ImportProcessor
 */
export interface ImportProcessorOptions {
  dbClient: DatabaseClient;
  logger?: pino.Logger;
}

// Scribe context chunking configuration (for future Batch API integration)
// const SCRIBE_CONTEXT_SIZE = 200; // Messages per Scribe request
// const SCRIBE_OVERLAP = 20; // Overlap between chunks

/**
 * Import processor that handles the full workflow.
 */
export class ImportProcessor {
  private dbClient: DatabaseClient;
  private logger: pino.Logger;
  private jobRepo: ImportJobRepository;
  private familyRepo: FamilyRepository;
  private eventLogRepo: EventLogRepository;
  private personRepo: PersonRepository;
  private familyAccessRepo: FamilyAccessRepository;
  // For future Batch API integration
  // private registrar: RegistrarAgent;

  constructor(options: ImportProcessorOptions) {
    this.dbClient = options.dbClient;
    this.logger = options.logger || createLogger({ name: 'import-processor' });

    this.jobRepo = new ImportJobRepository(this.dbClient);
    this.familyRepo = new FamilyRepository(this.dbClient);
    this.eventLogRepo = new EventLogRepository(this.dbClient);
    this.personRepo = new PersonRepository(this.dbClient);
    this.familyAccessRepo = new FamilyAccessRepository(this.dbClient);
    // For future Batch API integration
    // this.registrar = new RegistrarAgent({ dbClient: this.dbClient });
  }

  /**
   * Process an import job.
   * This is the main entry point for background processing.
   */
  async processJob(jobId: string): Promise<void> {
    const job = await this.jobRepo.findById(jobId);
    if (!job) {
      throw new Error(`Import job ${jobId} not found`);
    }

    if (job.status === 'complete' || job.status === 'cancelled') {
      this.logger.info({ jobId }, 'Job already completed or cancelled');
      return;
    }

    try {
      // Resume from last checkpoint or start fresh
      await this.runImport(job);
    } catch (error) {
      // Cancellation is not a failure — just stop processing
      if (error instanceof CancellationError) {
        this.logger.info({ jobId }, 'Import job cancelled');
        return;
      }

      this.logger.error({ jobId, error }, 'Import job failed');

      await this.jobRepo.update(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });

      // Log failure
      if (job.familyId) {
        await this.eventLogRepo.log({
          familyId: job.familyId,
          eventType: 'import_failed',
          eventCategory: 'system_event',
          actor: 'system',
          actorType: 'system',
          severity: 'error',
          eventData: {
            importJobId: jobId,
            source: job.source,
            error: error instanceof Error ? error.message : String(error),
            failedAt: job.progress?.stage || 'unknown',
          },
        });
      }

      throw error;
    }
  }

  /**
   * Check if the job has been cancelled. Throws to abort processing.
   */
  private async checkCancelled(jobId: string): Promise<void> {
    const job = await this.jobRepo.findById(jobId);
    if (job?.status === 'cancelled') {
      throw new CancellationError(jobId);
    }
  }

  /**
   * Run the import workflow.
   */
  private async runImport(job: ImportJob): Promise<void> {
    const rawFileContent = job.metadata.rawFileContent;
    if (!rawFileContent) {
      throw new Error('Job missing raw file content in metadata');
    }

    const parseResult = parseWhatsAppExport(rawFileContent);
    const messages = parseResult.messages;
    const config = job.config;

    this.logger.info(
      { jobId: job.id, messageCount: messages.length },
      'Starting import',
    );

    // Step 1: Create family (if not already created)
    let familyId = job.familyId;
    if (!familyId) {
      await this.jobRepo.update(job.id, {
        status: 'creating_family',
        progress: { ...job.progress, stage: 'Creating family...' },
      });

      const family = await this.familyRepo.create(config.family.name, {
        defaultLanguage: config.family.defaultLanguage,
        timezone: config.family.timezone,
        importSource: job.source,
      });

      familyId = family.id;
      await this.jobRepo.update(job.id, { familyId });

      this.logger.info({ jobId: job.id, familyId }, 'Family created');

      // Grant the importing user admin access to the new family
      if (job.createdBy) {
        await this.familyAccessRepo.upsert(
          job.createdBy, // identity_id of the super_admin
          familyId,
          'admin',
          'admin', // grantedBy - granted by admin action
          { notes: `Auto-granted during import job ${job.id}` },
        );
        this.logger.info(
          { jobId: job.id, familyId, identityId: job.createdBy },
          'Granted admin access to importing user',
        );
      }

      // Log import started event (after family is created so we have familyId)
      await this.eventLogRepo.log({
        familyId,
        eventType: 'import_started',
        eventCategory: 'system_event',
        actor: 'system',
        actorType: 'system',
        severity: 'info',
        eventData: {
          importJobId: job.id,
          source: job.source,
          messageCount: messages.length,
          participantCount: config.participants.length,
          dateRange:
            messages.length > 0
              ? {
                  start: messages[0].occurredAt.toISOString(),
                  end: messages[messages.length - 1].occurredAt.toISOString(),
                }
              : null,
        },
      });
    }

    // Step 2: Create identities/people for participants
    await this.jobRepo.update(job.id, {
      status: 'creating_identities',
      progress: { ...job.progress, stage: 'Creating participants...' },
    });

    const participantMap = new Map<string, string>(); // rawName -> personId

    for (const participant of config.participants) {
      // Check if person already exists (e.g. on resume after partial failure)
      const existing = await this.personRepo.findByName(
        familyId,
        participant.displayName,
      );

      const person =
        existing ||
        (await this.personRepo.createNew(
          familyId,
          {
            name: participant.displayName,
            aliases:
              participant.rawName !== participant.displayName
                ? [participant.rawName]
                : [],
            confidence: 'high',
          },
          undefined, // no source event
          'import', // claimedBy
          'import-v1', // extractionVersion
        ));

      participantMap.set(participant.rawName, person.id);
      this.logger.debug(
        {
          participantRawName: participant.rawName,
          personId: person.id,
          reused: !!existing,
        },
        existing ? 'Reused existing participant' : 'Created participant',
      );
    }

    // Generate a conversation ID for this import
    const conversationId = job.conversationId || `import-${job.id}`;
    if (!job.conversationId) {
      await this.jobRepo.update(job.id, { conversationId });
    }

    // Step 3: Insert conversation events
    await this.jobRepo.update(job.id, {
      status: 'submitting',
      progress: { ...job.progress, stage: 'Inserting messages...' },
    });

    // Re-parse timestamps with the correct timezone
    const timezone = config.family.timezone;
    for (const message of messages) {
      try {
        message.occurredAt = parseTimestampWithTimezone(
          message.rawTimestamp,
          timezone,
        );
      } catch {
        // Keep original parsed date if re-parsing fails
        this.logger.warn(
          { rawTimestamp: message.rawTimestamp },
          'Failed to re-parse timestamp with timezone',
        );
      }
    }

    // Create an ingestion batch to track this import
    const { data: batchRow, error: batchError } = await this.dbClient
      .from('ingestion_batches')
      .insert({
        family_id: familyId,
        source: job.source,
        ingestion_started_at: new Date().toISOString(),
        status: 'in_progress',
        metadata: { importJobId: job.id },
      })
      .select()
      .single();

    if (batchError) {
      throw new Error(
        `Failed to create ingestion batch: ${batchError.message}`,
      );
    }

    const ingestionBatchId = batchRow.id;
    this.logger.info(
      { jobId: job.id, ingestionBatchId },
      'Ingestion batch created',
    );

    // Insert all conversation events in batches.
    // Uses upsert with ignoreDuplicates (ON CONFLICT DO NOTHING) so that
    // resume after a partial failure skips already-inserted rows without
    // needing a per-row SELECT — eliminates the N+1 query.
    const lastProcessedIndex = job.progress?.lastProcessedEventId
      ? messages.findIndex(
          (m) => m.externalEventId === job.progress.lastProcessedEventId,
        )
      : -1;

    const startIndex = lastProcessedIndex + 1;
    const eventsToInsert = messages.slice(startIndex);
    const BATCH_SIZE = 100;
    let insertedCount = 0;

    for (let i = 0; i < eventsToInsert.length; i += BATCH_SIZE) {
      const batch = eventsToInsert.slice(i, i + BATCH_SIZE);

      const rows = batch.map((message) => ({
        family_id: familyId,
        source: job.source,
        conversation_id: conversationId,
        external_event_id: message.externalEventId,
        actor_external_id: message.actorRawName,
        actor_display_name: message.actorDisplayName,
        event_type: message.eventType,
        content_original: message.content,
        occurred_at: message.occurredAt.toISOString(),
        ingestion_batch_id: ingestionBatchId,
      }));

      const { error: insertError } = await this.dbClient
        .from('conversation_events')
        .upsert(rows, {
          onConflict: 'family_id,source,conversation_id,external_event_id',
          ignoreDuplicates: true,
        });

      if (insertError) {
        // Mark batch as failed before re-throwing
        await this.dbClient
          .from('ingestion_batches')
          .update({
            status: 'failed',
            ingestion_ended_at: new Date().toISOString(),
            event_count: insertedCount,
          })
          .eq('id', ingestionBatchId);
        throw new Error(
          `Failed to insert batch at offset ${i}: ${insertError.message}`,
        );
      }

      insertedCount = startIndex + i + batch.length;
      const lastMessage = batch[batch.length - 1];
      await this.jobRepo.update(job.id, {
        progress: {
          current: insertedCount,
          total: messages.length,
          stage: `Inserted ${insertedCount} / ${messages.length} messages`,
          lastProcessedEventId: lastMessage.externalEventId,
        },
      });

      // Check for cancellation between batches
      await this.checkCancelled(job.id);
    }

    // Finalize the ingestion batch
    await this.dbClient
      .from('ingestion_batches')
      .update({
        status: 'completed',
        ingestion_ended_at: new Date().toISOString(),
        event_count: messages.length,
      })
      .eq('id', ingestionBatchId);

    this.logger.info(
      {
        jobId: job.id,
        ingestionBatchId,
        eventsInserted: eventsToInsert.length,
      },
      'Conversation events inserted',
    );

    // Step 4: Pause for Intern review. Transition atomically so a cancel
    // after the last batch cannot be overwritten by this final status update.
    const reviewJob = await this.jobRepo.transitionStatus(
      job.id,
      ['submitting'],
      'awaiting_intern',
      {
        current: messages.length,
        total: messages.length,
        stage: 'Messages imported. Ready for Intern review.',
      },
    );

    if (!reviewJob) {
      await this.checkCancelled(job.id);
      throw new Error(
        'Import job status changed before Intern review transition',
      );
    }

    // Log that messages are imported (not complete - Intern/Scribe still pending)
    await this.eventLogRepo.log({
      familyId,
      eventType: 'import_messages_inserted',
      eventCategory: 'system_event',
      actor: 'system',
      actorType: 'system',
      severity: 'info',
      eventData: {
        importJobId: job.id,
        ingestionBatchId,
        source: job.source,
        messagesInserted: messages.length,
        participantsCreated: config.participants.length,
      },
    });

    this.logger.info(
      { jobId: job.id, messagesInserted: messages.length },
      'Messages inserted, awaiting Intern review',
    );
  }
}
