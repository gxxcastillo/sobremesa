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

**Causes:**

- Rate limit exceeded
- Network timeout
- API outage
- Invalid response

**Strategy:**

```typescript
class ClaudeClient {
  async callClaude(
    prompt: string,
    options: ClaudeOptions,
  ): Promise<ClaudeResponse> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: options.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        });

        return response;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);

        if (!isRetryable || attempt === maxRetries) {
          // Log failure
          await this.logError({
            error,
            prompt: prompt.substring(0, 100), // Don't log full prompt
            attempt,
            familyId: options.familyId,
          });

          throw new ClaudeAPIError(
            `Claude API failed after ${attempt} attempts`,
            error,
          );
        }

        // Exponential backoff
        const delay = baseDelay * Math.pow(2, attempt - 1);
        await this.sleep(delay);
      }
    }
  }

  private isRetryableError(error: any): boolean {
    // Rate limit (429) - retry
    if (error.status === 429) return true;

    // Timeout - retry
    if (error.code === 'ETIMEDOUT') return true;

    // Server error (5xx) - retry
    if (error.status >= 500) return true;

    // Client error (4xx) - don't retry
    if (error.status >= 400 && error.status < 500) return false;

    // Network error - retry
    if (error.code === 'ECONNREFUSED') return true;

    return false;
  }
}
```

**Fallback Behavior:**

```typescript
async function processMessageWithFallback(message: Message, familyId: string) {
  try {
    // Try Scribe processing
    const domainModel = await scribe.process(message);
    await registrar.save(domainModel);
  } catch (error) {
    if (error instanceof ClaudeAPIError) {
      // Claude failed - save message as "processing_failed"
      await db
        .from('messages')
        .update({
          processing_status: 'failed',
          processing_error: error.message,
        })
        .eq('id', message.id);

      // Add to retry queue (process later when Claude recovers)
      await retryQueue.add({
        messageId: message.id,
        familyId,
        retryAfter: Date.now() + 60000, // 1 minute
      });

      // Log to event_log
      await logEvent({
        familyId,
        eventType: 'processing_failed',
        actor: 'scribe',
        eventData: {
          messageId: message.id,
          error: error.message,
          willRetry: true,
        },
      });

      // DON'T throw - continue processing other messages
      return;
    }

    throw error; // Re-throw non-API errors
  }
}
```

---

### 2. Database Write Failures

**Causes:**

- Connection lost
- Constraint violation
- Supabase outage

**Strategy:**

```typescript
class Registrar {
  async save(domainModel: DomainModel): Promise<void> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use transaction for atomicity
        await this.db.rpc('begin');

        try {
          // Save all entities
          await this.savePeople(domainModel.entities.people);
          await this.savePlaces(domainModel.entities.places);
          await this.saveClaims(domainModel.claims);

          // Commit transaction
          await this.db.rpc('commit');

          return; // Success
        } catch (innerError) {
          // Rollback on error
          await this.db.rpc('rollback');
          throw innerError;
        }
      } catch (error) {
        const isRetryable = this.isRetryableDBError(error);

        if (!isRetryable || attempt === maxRetries) {
          // Log failure
          await this.logDatabaseError({
            error,
            domainModel: domainModel.metadata,
            attempt,
          });

          throw new DatabaseError(
            `Database write failed after ${attempt} attempts`,
            error,
          );
        }

        // Wait before retry
        await this.sleep(1000 * attempt);
      }
    }
  }

  private isRetryableDBError(error: any): boolean {
    // Connection error - retry
    if (error.code === 'ECONNREFUSED') return true;
    if (error.code === 'ETIMEDOUT') return true;

    // Deadlock - retry
    if (error.code === '40P01') return true;

    // Constraint violation - don't retry
    if (error.code === '23505') return false; // Unique violation
    if (error.code === '23503') return false; // Foreign key violation

    return false;
  }
}
```

**Constraint Violations:**

```typescript
async function handleConstraintViolation(error: PostgresError) {
  if (error.code === '23505') {
    // Unique constraint - likely duplicate insert
    // This is OKAY for idempotent operations
    logger.warn({ error }, 'Duplicate insert attempted (likely retry)');
    return; // Don't fail
  }

  if (error.code === '23503') {
    // Foreign key violation - data integrity issue
    logger.error({ error }, 'Foreign key violation');
    throw new DataIntegrityError('Referenced entity does not exist');
  }
}
```

---

### 3. Queue Processing Failures

**Causes:**

- Queue service down (Redis)
- Message processing timeout
- Corrupted message

**Strategy:**

```typescript
class MessageQueue {
  async process(familyId: string): Promise<void> {
    const messageId = await this.dequeue(familyId);

    if (!messageId) return; // Queue empty

    try {
      // Load message
      const message = await this.loadMessage(messageId);

      if (!message) {
        throw new Error(`Message ${messageId} not found`);
      }

      // Process with timeout
      await this.processWithTimeout(message, familyId, 30000); // 30s timeout

      // Mark as processed
      await this.markProcessed(messageId);
    } catch (error) {
      // Log error
      await this.logProcessingError({
        messageId,
        familyId,
        error,
      });

      // Move to dead letter queue after 5 failures
      const failureCount = await this.getFailureCount(messageId);

      if (failureCount >= 5) {
        await this.moveToDeadLetter(messageId);
        await this.alertAdmin({
          messageId,
          familyId,
          reason: 'Max retries exceeded',
        });
      } else {
        // Re-queue for retry (with exponential backoff)
        const delay = Math.pow(2, failureCount) * 60000; // Minutes
        await this.requeue(messageId, familyId, delay);
      }
    }
  }

  async processWithTimeout(
    message: Message,
    familyId: string,
    timeout: number,
  ): Promise<void> {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Processing timeout')), timeout);
    });

    const processingPromise = processMessage(message, familyId);

    await Promise.race([processingPromise, timeoutPromise]);
  }
}
```

**Dead Letter Queue:**

```typescript
// Messages that failed after max retries
CREATE TABLE dead_letter_queue (
  id UUID PRIMARY KEY,
  family_id UUID NOT NULL,
  message_id UUID NOT NULL,
  failure_count INTEGER,
  last_error TEXT,
  original_timestamp TIMESTAMPTZ,
  moved_to_dlq_at TIMESTAMPTZ DEFAULT NOW()
);

// Admin can inspect and manually retry
async function inspectDeadLetterQueue(familyId: string) {
  return db
    .from('dead_letter_queue')
    .select('*')
    .eq('family_id', familyId)
    .order('moved_to_dlq_at', { ascending: false });
}
```

---

### 4. Translation Failures

**Causes:**

- Translation API down
- Unsupported language

**Strategy:**

```typescript
async function translateContent(
  content: string,
  from: string,
  to: string,
  familyId: string,
): Promise<string | null> {
  try {
    const translated = await translationClient.translate(content, from, to);
    return translated;
  } catch (error) {
    // Log but don't fail entire processing
    await logEvent({
      familyId,
      eventType: 'translation_failed',
      actor: 'translation_service',
      eventData: {
        from,
        to,
        error: error.message,
      },
    });

    // Return null - Registrar will store original only
    return null;
  }
}

// In Registrar
async function saveMessage(message: Message, domainModel: DomainModel) {
  const { originalContent, originalLanguage, translations } =
    domainModel.translations[0];

  await db.from('messages').insert({
    family_id: message.familyId,
    content_original: originalContent,
    language_original: originalLanguage,

    // These might be null if translation failed
    content_en: translations.find((t) => t.language === 'en')
      ?.translatedContent,
    content_es: translations.find((t) => t.language === 'es')
      ?.translatedContent,

    translation_status: translations.length > 0 ? 'complete' : 'failed',
  });
}
```

---

### 5. Facilitator Decision Failures

**Causes:**

- Real-time lever data missing
- Facilitator rules corrupted
- Claude API failure

**Strategy:**

```typescript
async function facilitatorDecision(
  question: Question,
  familyId: string,
): Promise<boolean> {
  try {
    // Load rules with fallbacks
    const rules = await this.loadRulesWithFallback(familyId);
    const levers = await this.loadLeversWithFallback(familyId);

    // Make decision
    const shouldAsk = await this.evaluateQuestion(question, rules, levers);

    return shouldAsk;
  } catch (error) {
    // Log error
    await logEvent({
      familyId,
      eventType: 'facilitator_decision_error',
      actor: 'facilitator',
      eventData: {
        questionId: question.id,
        error: error.message,
      },
    });

    // CONSERVATIVE FALLBACK: Don't ask if error
    // Better to be silent than to spam on error
    return false;
  }
}

async function loadRulesWithFallback(
  familyId: string,
): Promise<FacilitatorRules> {
  try {
    const rules = await db
      .from('facilitator_rules')
      .select('*')
      .eq('family_id', familyId)
      .single();

    return rules.data;
  } catch (error) {
    logger.warn({ familyId }, 'Failed to load rules, using defaults');

    // Return safe defaults
    return {
      maxQuestionsPerWindow: 1, // Conservative
      minimumWaitAfterQuestion: 48, // Long wait
      currentSignal: 'hold_back', // Don't ask
      windowSizeHours: 24,
    };
  }
}
```

---

## Error Logging

### Event Log Structure

```typescript
interface ErrorEvent {
  family_id: string;
  event_type:
    | 'processing_error'
    | 'api_error'
    | 'database_error'
    | 'queue_error';
  actor: string; // Which component failed
  timestamp: string;
  event_data: {
    error_message: string;
    error_code?: string;
    stack_trace?: string; // Only in development
    context: {
      message_id?: string;
      question_id?: string;
      claim_id?: string;
      // ... relevant IDs
    };
    retry_count?: number;
    will_retry: boolean;
  };
}
```

### Error Severity Levels

```typescript
enum ErrorSeverity {
  INFO = 'info', // Retryable, expected (rate limit)
  WARNING = 'warning', // Degraded functionality (translation failed)
  ERROR = 'error', // Component failed but system continues
  CRITICAL = 'critical', // System-wide failure
}

async function logError(
  familyId: string,
  severity: ErrorSeverity,
  error: Error,
  context: Record<string, any>,
) {
  await db.from('event_log').insert({
    family_id: familyId,
    event_type: 'error',
    actor: context.actor || 'unknown',
    timestamp: new Date().toISOString(),
    event_data: {
      severity,
      error_message: error.message,
      error_code: error.code,
      stack_trace:
        process.env.NODE_ENV === 'development' ? error.stack : undefined,
      context,
    },
  });

  // Critical errors trigger alerts
  if (severity === ErrorSeverity.CRITICAL) {
    await alertAdmin({
      familyId,
      message: `Critical error: ${error.message}`,
      context,
    });
  }
}
```

---

## Monitoring & Alerts

### Health Checks

```typescript
// apps/chatbots/src/health.ts
export async function healthCheck(): Promise<HealthStatus> {
  const checks = await Promise.allSettled([
    checkDatabase(),
    checkClaudeAPI(),
    checkQueue(),
    checkTranslation(),
  ]);

  const failures = checks.filter((c) => c.status === 'rejected');

  return {
    healthy: failures.length === 0,
    timestamp: new Date().toISOString(),
    checks: {
      database: checks[0].status === 'fulfilled',
      claude: checks[1].status === 'fulfilled',
      queue: checks[2].status === 'fulfilled',
      translation: checks[3].status === 'fulfilled',
    },
    errors: failures.map((f) => f.reason),
  };
}

async function checkDatabase(): Promise<void> {
  await db.from('families').select('id').limit(1);
}

async function checkClaudeAPI(): Promise<void> {
  await claudeClient.callClaude('test', { maxTokens: 10 });
}
```

### Metrics to Track

```typescript
interface SystemMetrics {
  // Processing
  messages_processed_per_hour: number;
  messages_failed_per_hour: number;
  average_processing_time_ms: number;

  // Queue
  queue_depth_by_family: Record<string, number>;
  dead_letter_queue_depth: number;

  // API calls
  claude_api_calls_per_hour: number;
  claude_api_errors_per_hour: number;
  claude_api_p95_latency_ms: number;

  // Database
  database_writes_per_hour: number;
  database_errors_per_hour: number;
  database_p95_latency_ms: number;

  // Facilitator
  questions_asked_per_hour: number;
  questions_answered_per_hour: number;
  question_ignore_rate: number;
}
```

---

## Circuit Breaker Pattern

**Prevent cascading failures:**

```typescript
class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000, // 1 minute
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if timeout expired
      if (this.shouldAttemptReset()) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.threshold) {
      this.state = 'open';
      logger.error('Circuit breaker opened');
    }
  }

  private shouldAttemptReset(): boolean {
    return (
      this.lastFailureTime !== null &&
      Date.now() - this.lastFailureTime >= this.timeout
    );
  }
}

// Usage
const claudeCircuitBreaker = new CircuitBreaker(5, 60000);

async function callClaudeWithCircuitBreaker(prompt: string) {
  return claudeCircuitBreaker.execute(() =>
    claudeClient.callClaude(prompt, options),
  );
}
```

---

## Graceful Shutdown

**Clean shutdown on SIGTERM:**

```typescript
// apps/chatbots/src/main.ts
let isShuttingDown = false;

process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Received SIGTERM, shutting down gracefully...');

  // Stop accepting new messages
  bot.stopPolling();

  // Wait for current processing to finish (max 30s)
  await Promise.race([waitForQueueEmpty(), sleep(30000)]);

  // Close database connections
  await db.close();

  // Close Redis connection
  await redis.quit();

  logger.info('Shutdown complete');
  process.exit(0);
});

async function waitForQueueEmpty() {
  while (true) {
    const depth = await queue.getTotalDepth();
    if (depth === 0) break;
    await sleep(1000);
  }
}
```

---

## Summary: Error Handling Checklist

- [ ] Claude API failures → Retry with exponential backoff
- [ ] Database failures → Transaction rollback + retry
- [ ] Queue failures → Dead letter queue after max retries
- [ ] Translation failures → Graceful degradation (original only)
- [ ] Facilitator failures → Conservative fallback (don't ask)
- [ ] All errors logged to event_log
- [ ] Critical errors trigger alerts
- [ ] Circuit breakers for external APIs
- [ ] Health check endpoint implemented
- [ ] Graceful shutdown on SIGTERM
- [ ] Metrics tracked and monitored
- [ ] Dead letter queue inspectable by admin
