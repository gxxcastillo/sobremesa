# ADR-026: LLM Evaluation Queue Architecture

## Status

Accepted

**Implementation status (2026-07-02):** The queue is producer-only. The Registrar enqueues rows
into `llm_evaluation_queue`, but no worker acquires/drains them (`acquireBatch` has no call sites;
no `LlmEvaluationService` exists). Whether to build a drain worker or retire the queue is open
work.

## Date

2026-01-26

## Context

The system needed a way to selectively apply LLM evaluation to uncertain or complex claims without processing every claim through expensive LLM calls.

Initial approach used flag-based polling with columns on the `claims` table:

- `needs_llm_evaluation BOOLEAN`
- `llm_eval_locked_at`, `llm_eval_locked_by`, `llm_eval_attempts`, `llm_eval_last_error`

Problems with flag polling:

- Poor performance with millions of claims (scanning full table)
- No prioritization (high-stakes claims processed same as normal)
- Limited to claims only (couldn't queue entity matching or conflict resolution)
- Manual lock cleanup required
- No built-in metrics or monitoring
- Difficult to implement batching or grouping strategies

## Decision

Create a dedicated `llm_evaluation_queue` table with:

### Queue Structure

- **Entity polymorphism:** Support multiple evaluation types (claim_strength, entity_match, conflict_resolution)
- **Priority field:** 0-100 scale, high-stakes claims get priority 100
- **Context JSONB:** Store additional context needed for evaluation
- **Status workflow:** `pending` → `locked` → `completed`/`failed`/`cancelled`
- **Lock management:** `locked_at`, `locked_by`, `locked_until` for distributed workers
- **Retry logic:** `attempts`, `max_attempts`, `last_error` for exponential backoff
- **Performance tracking:** `processing_time_ms` to monitor LLM call duration

### Optimistic Locking

Workers use `FOR UPDATE SKIP LOCKED` to atomically claim items:

```sql
UPDATE llm_evaluation_queue
SET status = 'locked', locked_at = NOW(), locked_by = $workerId
WHERE id IN (
  SELECT id FROM llm_evaluation_queue
  WHERE status = 'pending'
  ORDER BY priority DESC, created_at ASC
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### Automatic Cleanup

Database function `cleanup_expired_evaluation_locks()` releases expired locks:

- Locks expire after 15 minutes
- Run by cron job every minute
- Resets expired locked items to pending

### Indexing Strategy

- `idx_llm_queue_pending`: Efficient worker queries (family_id, status, priority, created_at)
- `idx_llm_queue_expired_locks`: Fast cleanup (locked_until WHERE status='locked')
- `idx_llm_queue_entity`: Lookup by entity (entity_type, entity_id)
- `idx_llm_queue_stats`: Monitoring queries (family_id, status, created_at)

### Integration Points

**Registrar enqueues after creating claims:**

```typescript
if (strengthResult.needsLlmEvaluation) {
  await llmQueueRepo.enqueue(familyId, 'claim_strength', 'claim', claimId, {
    priority: isHighStakes ? 100 : 0,
    context: { claimType, algorithmScore, triggers },
  });
}
```

**Background worker processes queue:**

```typescript
const items = await queueRepo.acquireBatch(workerId, 10, 15);
for (const item of items) {
  const result = await evaluateWithLLM(item);
  await queueRepo.complete(item.id, result, processingTime);
}
```

## Consequences

### Positive

- **Prioritization:** High-stakes claims (birth/death dates) evaluated first
- **Performance:** Focused indexes, no full table scans
- **Scalability:** Multiple workers can process in parallel with no conflicts
- **Extensibility:** Supports multiple evaluation types beyond claims
- **Monitoring:** Built-in stats and metrics (pending, completed, failed, avg processing time)
- **Reliability:** Automatic lock cleanup prevents stuck items
- **Retry logic:** Failed items automatically retry with backoff
- **Audit trail:** Complete history preserved in queue table

### Negative

- **Additional table:** More schema complexity
- **Data duplication:** Context stored in both claims and queue
- **Worker infrastructure:** Requires separate worker process/container
- **Cleanup overhead:** Cron job needed for lock cleanup

### Trade-off

**Scalability and reliability worth the infrastructure.**

For a production system processing thousands of claims, the queue architecture provides:

- Clear separation of concerns (ingestion vs evaluation)
- Ability to scale workers independently
- Resilience to worker failures (automatic retry)
- Visibility into processing status and performance

The alternative (flag polling) would become a bottleneck as data grows. The queue enables:

- Cost optimization (only evaluate 5-10% of claims with LLM)
- Quality prioritization (high-stakes claims evaluated immediately)
- System reliability (workers can fail without losing work)
