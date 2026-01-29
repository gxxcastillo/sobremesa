# Error Handling & Resilience

How Sobremesa handles failures gracefully.

---

## Core Principles

1. **Degrade gracefully** - Partial failure doesn't stop the system
2. **Never lose messages** - Messages are sacred
3. **Retry intelligently** - Exponential backoff, not infinite loops
4. **Log everything** - Failures go to event_log
5. **Fail visibly** - Don't hide errors from developers

---

## Failure Scenarios

### Claude API Failures

**Retry strategy:** Max 3 retries with exponential backoff (1s, 2s, 4s)

- Retry: Rate limits, timeouts, server errors, network errors
- Don't retry: Client errors, invalid prompts

**Fallback:** Mark as `processing_failed`, add to retry queue, continue processing other messages

### Database Write Failures

**Strategy:** Use transactions for atomicity, retry transient errors, log permanent failures

**Constraint violations:**

- Unique → Entity exists, safe to ignore
- Foreign key → Missing reference, log and skip
- Check → Validation failed, log for review

### Telegram API Failures

**Rate limits:** Token bucket algorithm, queue messages (don't drop)

**Webhooks:** Acknowledge immediately (200 status), process asynchronously

### Queue Processing Failures

**Stuck messages:** 5-minute timeout, release lock, dead letter after 3 failures

**Poison messages:** Always-failing messages move to dead letter queue after 3 attempts, alert for review

---

## Error Logging

All errors logged to `event_log` table:

- Type, category, actor, error details, context
- Levels: ERROR (unexpected), WARN (expected with fallback), INFO (normal ops)
- Don't log: Message content, secrets, PII

---

## Resilience Patterns

### Circuit Breaker

Prevent cascading failures by opening circuit after threshold failures, allowing system to recover

**States:** Closed (normal) → Open (failing) → Half-open (testing recovery)

**Used for:** External APIs (Claude, Telegram), database during outages

### Graceful Shutdown

On SIGTERM: Stop accepting new work → Finish current (30s timeout) → Release locks → Close connections

---

## Monitoring

**Key metrics:** Queue depth, error rate, API failures, processing latency

**Alerts:** Slack/Discord (urgent), email (daily summaries), dashboard (real-time)

**Health check:** `/health` endpoint validates database, queue workers, error rates

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture overview
- [AGENTS.md](AGENTS.md) - Agent specifications and flows
