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

### 1. Claude API Failures

**Retry strategy:**

- Max 3 retries with exponential backoff (1s, 2s, 4s)
- Retry on: Rate limits (429), timeouts, server errors (5xx), network errors
- Don't retry: Client errors (4xx), invalid prompts
- Log all failures to event_log

**Fallback:**

- Mark message as `processing_failed`
- Add to retry queue for later processing
- Continue with other messages (don't block)

```typescript
async function processWithRetry(message: Message) {
  try {
    return await scribe.process(message); // Retries internally
  } catch (error) {
    if (error instanceof ClaudeAPIError) {
      await markFailed(message.id);
      await retryQueue.add({
        messageId: message.id,
        retryAfter: Date.now() + 60000,
      });
      return; // Don't throw - graceful degradation
    }
    throw error;
  }
}
```

---

### 2. Database Write Failures

**Strategy:**

- Wrap in transactions where atomicity required
- Retry transient errors (connection lost, deadlock)
- Don't retry permanent errors (constraint violations)
- Log failure, preserve data for manual recovery

**Constraint violations:**

- Unique constraint → Entity already exists, safe to ignore
- Foreign key → Referenced entity missing, log and skip
- Check constraint → Data validation failed, log for review

```typescript
async function saveWithRetry(data: DomainModel) {
  try {
    await db.transaction(async (tx) => {
      await savePeople(tx, data.entities.people);
      await saveClaims(tx, data.claims);
      await saveQuestions(tx, data.questions);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      logger.info('Entity already exists, skipping');
      return;
    }
    if (isForeignKeyViolation(error)) {
      logger.error('Referenced entity missing', { error, data });
      await saveToDeadLetterQueue(data);
      return;
    }
    throw error; // Re-throw unexpected errors
  }
}
```

---

### 3. Telegram API Failures

**Rate limits:**

- Respect 30 messages/second global limit
- Use token bucket algorithm
- Queue messages, don't drop them

**Network failures:**

- Retry message sends (3 attempts)
- Log unsent messages
- Admin notification if failures persist

**Webhook failures:**

- Return 200 immediately (acknowledge receipt)
- Process asynchronously
- Telegram will retry if we don't respond within 60s

```typescript
async function handleWebhook(update: TelegramUpdate) {
  // Acknowledge immediately
  setImmediate(async () => {
    try {
      await processUpdate(update);
    } catch (error) {
      await logError(error, { update });
      // Don't throw - already acknowledged
    }
  });

  return { statusCode: 200 }; // Acknowledge receipt
}
```

---

### 4. Queue Processing Failures

**Stuck messages:**

- Timeout after 5 minutes processing
- Release lock, allow retry
- Dead letter queue after 3 failures

**Worker crashes:**

- Use heartbeat mechanism
- Release locks if worker stops heartbeat
- Auto-restart workers

**Poison messages:**

- Messages that always fail (bad data, logic error)
- After 3 failures, move to dead letter queue
- Alert for manual review

```typescript
async function processQueueItem(item: QueueItem) {
  const maxAttempts = 3;

  try {
    await processMessage(item.messageId);
    await queue.complete(item.id);
  } catch (error) {
    item.attempts += 1;

    if (item.attempts >= maxAttempts) {
      await deadLetterQueue.add(item);
      await queue.delete(item.id);
      await alertAdmin('Poison message detected', { item, error });
    } else {
      await queue.retry(item.id, { delay: Math.pow(2, item.attempts) * 1000 });
    }
  }
}
```

---

## Error Logging

All errors logged to `event_log` table with:

- `event_type`: 'error_occurred'
- `event_category`: Component that failed ('scribe', 'registrar', 'telegram')
- `actor`: Agent or system component
- `event_data`: Error details, stack trace, context

**Log levels:**

- **ERROR**: Unexpected failures requiring investigation
- **WARN**: Expected failures with fallback (e.g., rate limit hit)
- **INFO**: Normal operations, successful retries

**Don't log:**

- Full message content (privacy)
- API keys or secrets
- User PII unless necessary

---

## Monitoring & Alerts

**Key metrics:**

- Processing queue depth (alert if > 1000)
- Error rate (alert if > 5% of messages)
- API failure rate (alert if Claude/Supabase down)
- Processing latency (alert if p95 > 5 seconds)

**Alert channels:**

- Slack/Discord for urgent issues
- Email for daily summaries
- Dashboard for real-time monitoring

**Health checks:**

- `/health` endpoint returns 200 if:
  - Database connection healthy
  - Queue worker running
  - No poison messages in queue
  - Error rate < 10%

---

## Circuit Breaker Pattern

Prevent cascading failures:

```typescript
class CircuitBreaker {
  state: 'closed' | 'open' | 'half-open' = 'closed';
  failures = 0;
  threshold = 5;
  timeout = 60000; // 1 minute

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker open');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.reset();
      }
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastFailure = Date.now();

      if (this.failures >= this.threshold) {
        this.state = 'open';
        await this.notifyAdmin('Circuit breaker opened');
      }
      throw error;
    }
  }

  reset() {
    this.state = 'closed';
    this.failures = 0;
  }
}
```

**Use for:**

- External API calls (Claude, Telegram)
- Database operations during outages
- Any expensive operations that might cascade

---

## Graceful Shutdown

Ensure clean shutdown on deploy/restart:

```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown');

  // 1. Stop accepting new work
  await stopAcceptingNewMessages();

  // 2. Finish current work (with timeout)
  await Promise.race([
    finishCurrentProcessing(),
    sleep(30000), // 30s timeout
  ]);

  // 3. Release locks
  await releaseAllLocks();

  // 4. Close connections
  await closeDatabase();
  await closeTelegram();

  logger.info('Graceful shutdown complete');
  process.exit(0);
});
```

---

## Error Handling Checklist

- [ ] All LLM calls wrapped in retry logic
- [ ] Database writes use transactions where needed
- [ ] Webhook handlers return 200 immediately
- [ ] Queue items have retry logic with dead letter queue
- [ ] Circuit breakers protect external dependencies
- [ ] Errors logged to event_log with context
- [ ] Monitoring alerts configured
- [ ] Graceful shutdown implemented
- [ ] Health check endpoint configured
- [ ] Rate limiting respects API limits

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture overview
- [AGENTS.md](AGENTS.md) - Agent specifications and flows
