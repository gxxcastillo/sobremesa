import type { DatabaseClient } from '../client';
import type {
  OutboundMessage,
  ClaimOutboundMessageParams,
  ClaimOutboundMessageResult,
} from '@sobremesa/shared-types';
import { mapRowToCamelCase } from '../base-repository.js';

/**
 * Repository for the durable outbound send ledger (`outbound_messages`).
 * Implements the claim-before-send, confirm-after state machine from
 * `outbound-send-reliability-plan.md`: `claim()` is the only place a row is
 * inserted or reclaimed, and stamps `send_attempted_at` immediately (not the
 * caller, and not right before the Telegram API call) -- a crash before the
 * real send therefore reads as ambiguous ('pending', never resent) rather
 * than safely reclaimable, matching the plan's lost-over-duplicate policy.
 */
export class OutboundMessageRepository {
  private client: DatabaseClient;
  private tableName = 'outbound_messages';

  constructor(client: DatabaseClient) {
    this.client = client;
  }

  /**
   * Claim a dedup key for sending. Inserts a fresh 'pending' row, or -- on a
   * unique-constraint conflict -- reads the existing row and branches:
   *   - 'sent'              -> 'duplicate' (do not send)
   *   - 'failed'            -> reclaim (attempts+1, content refreshed) -> 'claimed'
   *   - 'pending'/'unknown' -> 'ambiguous' (outcome of the prior claim is not
   *                            yet known; never resend)
   */
  async claim(
    params: ClaimOutboundMessageParams,
  ): Promise<ClaimOutboundMessageResult> {
    const { data, error } = await this.client
      .from(this.tableName)
      .insert({
        family_id: params.familyId,
        dedup_key: params.dedupKey,
        role: params.role,
        chat_id: params.chatId,
        content: params.content,
        status: 'pending',
        send_attempted_at: new Date().toISOString(),
        conversation_event_id: params.conversationEventId ?? null,
        question_id: params.questionId ?? null,
        attempts: 1,
      })
      .select()
      .single();

    if (!error) {
      return {
        outcome: 'claimed',
        message: mapRowToCamelCase<OutboundMessage>(data),
      };
    }

    if (error.code !== '23505') {
      throw new Error(`Failed to claim outbound message: ${error.message}`);
    }

    const existing = await this.findByDedupKey(
      params.familyId,
      params.dedupKey,
    );
    if (!existing) {
      // The conflicting row existed at insert time but is gone now -- the
      // caller can retry; there is nothing safe to branch on here.
      throw new Error(
        `Outbound message dedup conflict on '${params.dedupKey}' but no row found`,
      );
    }

    if (existing.status === 'sent') {
      return { outcome: 'duplicate', message: existing };
    }

    if (existing.status === 'failed') {
      return await this.reclaim(params, existing);
    }

    // 'pending' or 'unknown': a prior claim's outcome isn't known yet.
    // Per the lost-over-duplicate policy, never resend.
    return { outcome: 'ambiguous', message: existing };
  }

  /**
   * Reclaim a 'failed' row for a retry. Conditioned on `status = 'failed'`
   * in the WHERE clause: if a concurrent caller already reclaimed or
   * resolved it, this update matches zero rows and `.single()` reports
   * `PGRST116` -- treated as 'ambiguous' (the loser never resends) rather
   * than retried, since retrying here would just repeat the same race.
   */
  private async reclaim(
    params: ClaimOutboundMessageParams,
    existing: OutboundMessage,
  ): Promise<ClaimOutboundMessageResult> {
    const { data, error } = await this.client
      .from(this.tableName)
      .update({
        status: 'pending',
        content: params.content,
        chat_id: params.chatId,
        send_attempted_at: new Date().toISOString(),
        attempts: existing.attempts + 1,
        last_error: null,
      })
      .eq('family_id', params.familyId)
      .eq('id', existing.id)
      .eq('status', 'failed')
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        const current = await this.findByDedupKey(
          params.familyId,
          params.dedupKey,
        );
        return { outcome: 'ambiguous', message: current ?? existing };
      }
      throw new Error(`Failed to reclaim outbound message: ${error.message}`);
    }

    return {
      outcome: 'claimed',
      message: mapRowToCamelCase<OutboundMessage>(data),
    };
  }

  /**
   * Confirm a successful delivery.
   */
  async confirmSent(
    familyId: string,
    id: string,
    externalMessageId?: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({
        status: 'sent',
        external_message_id: externalMessageId ?? null,
        sent_at: new Date().toISOString(),
      })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(
        `Failed to confirm outbound message sent: ${error.message}`,
      );
    }
  }

  /**
   * Record a definitive delivery failure (4xx -- not delivered).
   */
  async confirmFailed(
    familyId: string,
    id: string,
    errorMessage: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({ status: 'failed', last_error: errorMessage })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(
        `Failed to mark outbound message failed: ${error.message}`,
      );
    }
  }

  /**
   * Record an ambiguous delivery outcome (5xx/network -- not resent).
   */
  async confirmUnknown(
    familyId: string,
    id: string,
    errorMessage: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(this.tableName)
      .update({ status: 'unknown', last_error: errorMessage })
      .eq('family_id', familyId)
      .eq('id', id);

    if (error) {
      throw new Error(
        `Failed to mark outbound message unknown: ${error.message}`,
      );
    }
  }

  /**
   * Sends an operator must look at (hardening J): 'failed'/'unknown' rows
   * created since `since`, plus every 'pending' row claimed before
   * `pendingBefore` -- a claim that never confirmed (crash mid-send), which
   * stays ambiguous and is never resent. `content` is left out: the report
   * locates the work, it doesn't copy family text.
   */
  async findNeedingAttention(
    familyId: string,
    options: { since: Date; pendingBefore: Date },
  ): Promise<Omit<OutboundMessage, 'content'>[]> {
    const columns =
      'id, family_id, dedup_key, role, chat_id, status, send_attempted_at, external_message_id, conversation_event_id, question_id, attempts, last_error, created_at, sent_at';

    const [settled, stalePending] = await Promise.all([
      this.client
        .from(this.tableName)
        .select(columns)
        .eq('family_id', familyId)
        .in('status', ['failed', 'unknown'])
        .gte('created_at', options.since.toISOString())
        .order('created_at', { ascending: false })
        .limit(100),
      this.client
        .from(this.tableName)
        .select(columns)
        .eq('family_id', familyId)
        .eq('status', 'pending')
        .lt('send_attempted_at', options.pendingBefore.toISOString())
        .order('send_attempted_at', { ascending: true })
        .limit(100),
    ]);

    const error = settled.error ?? stalePending.error;
    if (error) {
      throw new Error(
        `Failed to find outbound messages needing attention: ${error.message}`,
      );
    }

    return [...(settled.data || []), ...(stalePending.data || [])].map((row) =>
      mapRowToCamelCase<Omit<OutboundMessage, 'content'>>(row),
    );
  }

  /**
   * Find a row by its dedup key within a family.
   */
  async findByDedupKey(
    familyId: string,
    dedupKey: string,
  ): Promise<OutboundMessage | null> {
    const { data, error } = await this.client
      .from(this.tableName)
      .select('*')
      .eq('family_id', familyId)
      .eq('dedup_key', dedupKey)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to find outbound message: ${error.message}`);
    }

    return mapRowToCamelCase<OutboundMessage>(data);
  }
}
