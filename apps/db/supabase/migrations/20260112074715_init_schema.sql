-- ============================================================================
-- SOBREMESA DATABASE SCHEMA (FULL)
-- Family History Collection System
-- Provider-neutral, multi-family, claims-based
-- ============================================================================
--
-- Design Principles:
-- 1. Provider-neutral ingestion (chat service agnostic)
-- 2. Multi-family support
-- 3. Claims-based data model (provenance for everything)
-- 4. Conflict preservation (never auto-resolve)
-- 5. Complete audit trail (event log)
-- 6. Redaction support (soft delete + tombstones)
-- 7. Integrity-ready (HMAC/hash + checkpoint anchoring)
-- 8. Original language storage (translate on-read)
--
-- PostgreSQL 15+
-- Requires: pgcrypto (for gen_random_uuid)
-- Note: Requires PG15+ for security_invoker option on views
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Updated-at trigger helper
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';  -- Prevent search path manipulation attacks

-- ============================================================================
-- RLS HELPER FUNCTIONS (must be defined early for use in triggers)
-- ============================================================================
-- Get identity_id from JWT claims for RLS policies
CREATE OR REPLACE FUNCTION get_identity_id()
RETURNS UUID AS $$
BEGIN
  RETURN (current_setting('request.jwt.claims', true)::json->>'identity_id')::UUID;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION get_identity_id IS 'Get identity_id from JWT claims for RLS policies';

-- Check if current user is super admin
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_role TEXT;
BEGIN
  SELECT u.role INTO user_role
  FROM public.users u
  JOIN public.identities i ON i.user_id = u.id
  WHERE i.id = public.get_identity_id();

  RETURN COALESCE(user_role = 'super_admin', FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION is_super_admin IS 'Check if current user has super_admin role (from users table)';

-- Get family IDs the current user has active access to
CREATE OR REPLACE FUNCTION get_user_family_ids()
RETURNS SETOF UUID AS $$
BEGIN
  -- Super admins can access all families
  IF public.is_super_admin() THEN
    RETURN QUERY SELECT id FROM public.families;
  ELSE
    -- Regular users only see families they have active access to
    RETURN QUERY
    SELECT family_id
    FROM public.family_access
    WHERE identity_id = public.get_identity_id()
      AND status = 'active';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION get_user_family_ids IS 'Get family IDs the current user has active access to';

-- Get user's role in a specific family (only if access is active)
CREATE OR REPLACE FUNCTION get_family_role(target_family_id UUID)
RETURNS VARCHAR(20) AS $$
DECLARE
  access_role VARCHAR(20);
BEGIN
  -- Super admins have admin access to all families
  IF public.is_super_admin() THEN
    RETURN 'admin';
  END IF;

  SELECT role INTO access_role
  FROM public.family_access
  WHERE identity_id = public.get_identity_id()
    AND family_id = target_family_id
    AND status = 'active';

  RETURN access_role; -- Returns NULL if no active access
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION get_family_role IS 'Get user role for a specific family (admin, member, viewer, or NULL if no active access)';

-- Check if user is admin of a specific family
CREATE OR REPLACE FUNCTION is_family_admin(target_family_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.get_family_role(target_family_id) = 'admin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION is_family_admin IS 'Check if user is admin of a specific family';

-- Check if user has any access to a specific family
CREATE OR REPLACE FUNCTION has_family_access(target_family_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.get_family_role(target_family_id) IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION has_family_access IS 'Check if user has any access to a specific family (admin, member, or viewer)';

-- Alias for backwards compatibility
CREATE OR REPLACE FUNCTION is_family_member(target_family_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.has_family_access(target_family_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION is_family_member IS 'Deprecated: Use has_family_access() instead. Alias for backwards compatibility.';

-- ============================================================================
-- FAMILIES (Family Spaces / Tenants)
-- ============================================================================
CREATE TABLE IF NOT EXISTS families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,

  -- Optional config directly on the family for POC convenience
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Chat provider and ID for linking to a chat provider
  chat_source VARCHAR(50),                -- 'telegram', 'whatsapp', 'discord', etc.
  chat_id TEXT,

  is_active BOOLEAN DEFAULT TRUE,

  -- Composite unique constraint for (source, chat_id) to support multi-provider
  UNIQUE (chat_source, chat_id),

  CONSTRAINT valid_chat_source CHECK (
    chat_source IS NULL OR chat_source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  ),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE families IS 'Top-level family spaces (e.g. maternal side, paternal side). Multi-provider: use (chat_source, chat_id) pair.';

DROP TRIGGER IF EXISTS update_families_updated_at ON families;
CREATE TRIGGER update_families_updated_at
BEFORE UPDATE ON families
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_families_chat
  ON families(chat_source, chat_id)
  WHERE chat_source IS NOT NULL AND chat_id IS NOT NULL;

-- Prevent family deletion (tombstone via is_active instead)
CREATE OR REPLACE FUNCTION prevent_family_deletes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Families cannot be deleted - use is_active=false for tombstoning (family_id: %)', OLD.id
    USING HINT = 'Use UPDATE families SET is_active = false instead of DELETE';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_family_deletes IS 'Prevents family deletion. Consistent with immutable claims architecture - use is_active=false instead.';

DROP TRIGGER IF EXISTS enforce_families_no_delete ON families;
CREATE TRIGGER enforce_families_no_delete
  BEFORE DELETE ON families
  FOR EACH ROW
  EXECUTE FUNCTION prevent_family_deletes();

-- ============================================================================
-- FAMILY CONFIG (Optional separate table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS family_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Composite unique enables composite FKs if needed downstream
  CONSTRAINT uq_family_config_family_id UNIQUE (family_id, id)
);

COMMENT ON TABLE family_config IS 'Optional family configuration snapshots (JSON).';

CREATE INDEX IF NOT EXISTS idx_family_config_family
  ON family_config(family_id);

CREATE INDEX IF NOT EXISTS idx_family_config_active
  ON family_config(family_id, is_active)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_family_config_updated_at ON family_config;
CREATE TRIGGER update_family_config_updated_at
BEFORE UPDATE ON family_config
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- SEQUENCE COUNTERS (Generic atomic sequence assignment)
-- ============================================================================
-- Generic sequence counter supporting multiple scope types and use cases
-- Inspired by logical clocks but simplified for single-database ACID guarantees
CREATE TABLE IF NOT EXISTS sequence_counters (
  scope_type VARCHAR(50) NOT NULL,      -- 'family', 'conversation', 'global', 'user'
  scope_id UUID NOT NULL,               -- The ID being scoped (family_id, conversation_id, etc.)
  counter_name VARCHAR(50) NOT NULL,    -- 'events', 'claims', 'batches', 'messages', etc.
  next_sequence BIGINT NOT NULL DEFAULT 1,
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (scope_type, scope_id, counter_name)
);

COMMENT ON TABLE sequence_counters IS 'Generic atomic sequence counters for any entity type. Supports multiple scope levels (family, conversation, global).';
COMMENT ON COLUMN sequence_counters.scope_type IS 'The type of scope: family, conversation, global, user, etc.';
COMMENT ON COLUMN sequence_counters.scope_id IS 'The ID of the scoped entity (e.g., family_id for scope_type=family)';
COMMENT ON COLUMN sequence_counters.counter_name IS 'The name of the counter (e.g., events, claims, batches)';
COMMENT ON COLUMN sequence_counters.next_sequence IS 'The next sequence number to assign (atomically incremented)';

CREATE INDEX IF NOT EXISTS idx_sequence_counters_scope
  ON sequence_counters(scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_sequence_counters_scope_counter
  ON sequence_counters(scope_type, scope_id, counter_name);

-- ============================================================================
-- INGESTION BATCHES (Batch operation tracking)
-- ============================================================================
-- Used for cron jobs, manual imports, and bulk operations
-- NOT used for real-time Telegram polling (messages processed individually)
CREATE TABLE IF NOT EXISTS ingestion_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,                  -- 'telegram', 'manual_import', 'cron', etc.

  -- Wall-clock time when ingestion job started/ended (NOT event timestamps)
  ingestion_started_at TIMESTAMPTZ NOT NULL,
  ingestion_ended_at TIMESTAMPTZ,               -- NULL until batch completes

  event_count INTEGER,                          -- NULL until batch completes
  status VARCHAR(20) DEFAULT 'in_progress',     -- 'in_progress', 'completed', 'partial', 'failed'
  metadata JSONB,                               -- Batch-specific context

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_batch_source CHECK (
    source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email', 'manual_import', 'cron', 'bulk_import')
  ),
  CONSTRAINT valid_batch_status CHECK (
    status IS NULL OR status IN ('in_progress', 'completed', 'partial', 'failed')
  )
);

COMMENT ON TABLE ingestion_batches IS 'Tracks batch ingestion operations (cron jobs, manual imports). Real-time Telegram messages have NULL ingestion_batch_id.';
COMMENT ON COLUMN ingestion_batches.ingestion_started_at IS 'Wall-clock time when batch started (not event occurred_at times)';
COMMENT ON COLUMN ingestion_batches.event_count IS 'Total events in batch, set when status changes to completed/partial/failed';

CREATE INDEX IF NOT EXISTS idx_ingestion_batches_family
  ON ingestion_batches(family_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_batches_status
  ON ingestion_batches(family_id, status)
  WHERE status = 'in_progress';

-- ============================================================================
-- CONVERSATION EVENTS (Raw Ingestion Ledger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Ordering (assigned by trigger for deterministic replay)
  sequence_number BIGINT NOT NULL,

  -- Batch tracking (NULL for real-time messages, populated for batch operations)
  ingestion_batch_id UUID REFERENCES ingestion_batches(id) ON DELETE SET NULL,

  -- Provider identity
  source VARCHAR(50) NOT NULL,                  -- 'telegram', 'whatsapp', 'sms', etc.
  conversation_id VARCHAR(255) NOT NULL,        -- provider chat thread id
  external_event_id VARCHAR(255) NOT NULL,      -- provider message/event id
  external_reply_to_id VARCHAR(255),

  -- Actor snapshot (display-only; may change upstream)
  actor_external_id VARCHAR(255) NOT NULL,
  actor_display_name VARCHAR(255),
  actor_username VARCHAR(255),

  -- Event classification (POC: message/photo/document)
  event_type VARCHAR(50) NOT NULL DEFAULT 'message',  -- 'message','photo','document','join','leave','edit'

  -- Content (original language only; translate on-read)
  content_original TEXT,
  language_original VARCHAR(10),                -- 'es','en','unknown', etc.

  CONSTRAINT valid_source CHECK (
    source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  ),

  -- Provider-specific metadata
  metadata JSONB,

  -- Raw provider payload (optional; useful for debugging/replay)
  source_payload JSONB,

  -- Schema versioning (for safe evolution)
  payload_version INTEGER DEFAULT 1,
  metadata_version INTEGER DEFAULT 1,

  -- Integrity primitive (recommended: HMAC, not raw hash)
  content_hmac TEXT,

  -- Timestamps
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, source, conversation_id, external_event_id),
  -- Composite unique constraint enables composite FKs for tenant integrity (intentional, not redundant)
  CONSTRAINT uq_conversation_events_family_id UNIQUE (family_id, id),

  -- Enum-like constraints
  CONSTRAINT valid_event_type CHECK (
    event_type IN ('message', 'photo', 'document', 'join', 'leave', 'edit', 'video', 'audio', 'voice', 'sticker')
  )
);

COMMENT ON TABLE conversation_events IS 'Immutable ingestion ledger. State in processing_queue, redaction in conversation_redactions. RLS enabled: no direct client access; read via backend/admin only.';
COMMENT ON CONSTRAINT uq_conversation_events_family_id ON conversation_events IS 'Enables composite FK references (family_id, id) for multi-tenant integrity enforcement at DB level';
COMMENT ON COLUMN conversation_events.sequence_number IS 'Monotonic per-family sequence number for deterministic ordering. Assigned atomically by trigger.';
COMMENT ON COLUMN conversation_events.ingestion_batch_id IS 'NULL for real-time messages. Populated for batch operations (cron jobs, manual imports).';
COMMENT ON COLUMN conversation_events.metadata IS 'Provider-specific metadata (e.g., Telegram: message_id, chat_id, edit_date; WhatsApp: status_id, timestamp_ms).';
COMMENT ON COLUMN conversation_events.payload_version IS 'Schema version for source_payload structure (enables safe evolution).';
COMMENT ON COLUMN conversation_events.metadata_version IS 'Schema version for metadata structure (enables safe evolution).';

CREATE INDEX IF NOT EXISTS idx_conv_events_family_time
  ON conversation_events(family_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_events_family_conversation
  ON conversation_events(family_id, source, conversation_id);

CREATE INDEX IF NOT EXISTS idx_conv_events_family_sequence
  ON conversation_events(family_id, sequence_number);

-- Unique index prevents duplicate sequence numbers per family
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_events_family_sequence_unique
  ON conversation_events(family_id, sequence_number);

CREATE INDEX IF NOT EXISTS idx_conv_events_batch
  ON conversation_events(family_id, ingestion_batch_id)
  WHERE ingestion_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conv_events_reply_to
  ON conversation_events(family_id, source, conversation_id, external_reply_to_id)
  WHERE external_reply_to_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conv_events_family_ingested
  ON conversation_events(family_id, ingested_at DESC);

-- ----------------------------------------------------------------------------
-- Automatic sequence number assignment trigger
-- ----------------------------------------------------------------------------
-- Uses atomic UPDATE ... RETURNING on sequence_counters to prevent race conditions
CREATE OR REPLACE FUNCTION assign_event_sequence_number()
RETURNS TRIGGER AS $$
DECLARE
  assigned_sequence BIGINT;
BEGIN
  -- Prevent manual sequence_number assignment (avoid corruption)
  IF NEW.sequence_number IS NOT NULL THEN
    RAISE EXCEPTION 'sequence_number is auto-assigned and cannot be set manually'
      USING HINT = 'Remove sequence_number from INSERT statement';
  END IF;

  -- Atomically increment and return the sequence number
  -- Uses generic sequence_counters with scope_type='family', counter_name='events'
  UPDATE public.sequence_counters
  SET next_sequence = next_sequence + 1,
      last_updated_at = NOW()
  WHERE scope_type = 'family'
    AND scope_id = NEW.family_id
    AND counter_name = 'events'
  RETURNING next_sequence - 1 INTO assigned_sequence;

  -- If no counter exists yet, create one (handles new families)
  IF assigned_sequence IS NULL THEN
    INSERT INTO public.sequence_counters (scope_type, scope_id, counter_name, next_sequence)
    VALUES ('family', NEW.family_id, 'events', 2)
    ON CONFLICT (scope_type, scope_id, counter_name)
    DO UPDATE SET next_sequence = public.sequence_counters.next_sequence + 1,
                  last_updated_at = NOW()
    RETURNING next_sequence - 1 INTO assigned_sequence;
  END IF;

  NEW.sequence_number := assigned_sequence;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION assign_event_sequence_number IS 'Atomically assigns per-family sequence numbers to conversation_events using generic sequence_counters table.';

DROP TRIGGER IF EXISTS set_event_sequence_number ON conversation_events;
CREATE TRIGGER set_event_sequence_number
  BEFORE INSERT ON conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION assign_event_sequence_number();

-- ----------------------------------------------------------------------------
-- Generic sequence number helper function
-- ----------------------------------------------------------------------------
-- Reusable function for getting the next sequence number for any scope/counter
-- Can be called from application code or other triggers
CREATE OR REPLACE FUNCTION get_next_sequence(
  p_scope_type VARCHAR(50),
  p_scope_id UUID,
  p_counter_name VARCHAR(50)
) RETURNS BIGINT AS $$
DECLARE
  assigned_sequence BIGINT;
BEGIN
  -- Atomically increment and return the sequence number
  UPDATE public.sequence_counters
  SET next_sequence = next_sequence + 1,
      last_updated_at = NOW()
  WHERE scope_type = p_scope_type
    AND scope_id = p_scope_id
    AND counter_name = p_counter_name
  RETURNING next_sequence - 1 INTO assigned_sequence;

  -- If no counter exists yet, create one
  IF assigned_sequence IS NULL THEN
    INSERT INTO public.sequence_counters (scope_type, scope_id, counter_name, next_sequence)
    VALUES (p_scope_type, p_scope_id, p_counter_name, 2)
    ON CONFLICT (scope_type, scope_id, counter_name)
    DO UPDATE SET next_sequence = public.sequence_counters.next_sequence + 1,
                  last_updated_at = NOW()
    RETURNING next_sequence - 1 INTO assigned_sequence;
  END IF;

  RETURN assigned_sequence;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION get_next_sequence IS 'Atomically gets the next sequence number for any scope/counter combination. Thread-safe with row-level locking.';

-- ============================================================================
-- PROCESSING QUEUE (Ordered processing support)
-- ============================================================================
-- Use this if you're DB-polling workers (instead of Redis/BullMQ).
-- Maintains ordered, retryable processing with priority support.
CREATE TABLE IF NOT EXISTS processing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  conversation_event_id UUID NOT NULL,

  -- Priority: 1=highest, 10=lowest, default 5
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),

  -- Ordering: by priority, then queued_at
  queued_at TIMESTAMPTZ DEFAULT NOW(),

  -- Delayed processing: item won't be dequeued until this time (for debouncing)
  process_after TIMESTAMPTZ DEFAULT NOW(),

  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(255),

  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','done','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  CONSTRAINT uq_processing_queue_event UNIQUE(family_id, conversation_event_id),

  -- Composite FK enforces tenant integrity
  CONSTRAINT fk_processing_queue_event
    FOREIGN KEY (family_id, conversation_event_id) REFERENCES conversation_events(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE processing_queue IS 'Ordered processing queue for Scribe pipeline.';
COMMENT ON COLUMN processing_queue.priority IS
  'Message priority: 1=critical (user messages), 5=normal, 7=low (bot questions), 10=lowest';
COMMENT ON COLUMN processing_queue.process_after IS
  'Delayed processing: item not dequeued until this time. Used for debouncing (e.g., member events).';

-- Index for dequeue: only items where process_after <= now, priority ASC, then queued_at ASC
CREATE INDEX IF NOT EXISTS idx_processing_queue_ready
  ON processing_queue(family_id, status, process_after, priority ASC, queued_at ASC)
  WHERE status IN ('queued','error');

-- Index for global dequeue across all families
CREATE INDEX IF NOT EXISTS idx_processing_queue_global_ready
  ON processing_queue(status, process_after, priority ASC, queued_at ASC)
  WHERE status IN ('queued', 'error');

-- ============================================================================
-- PEOPLE (Identity + optional derived summaries)
-- ============================================================================
CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Primary identity
  name VARCHAR(255) NOT NULL,
  aliases TEXT[] DEFAULT '{}',

  -- Placeholder flag (for unknown people in family tree, e.g., "unknown parent of Maria")
  is_placeholder BOOLEAN DEFAULT FALSE,

  -- OPTIONAL derived summaries (canonical provenance lives in claims)
  birth_year INTEGER,
  birth_year_confidence VARCHAR(20),           -- 'high','medium','low'
  death_year INTEGER,
  death_year_confidence VARCHAR(20),

  -- Notes (original language only; translate on-read)
  notes_original TEXT,
  language_original VARCHAR(10),

  -- Source tracking
  first_mentioned_event_id UUID,
  created_by VARCHAR(255),

  -- Privacy
  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  -- Integrity (optional per-record HMAC for derived content)
  content_hmac TEXT,

  -- Entity merge tracking (denormalized from entity_merges for query performance)
  superseded_by UUID,
  superseded_at TIMESTAMPTZ,

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_people_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_people_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES people(family_id, id) ON DELETE SET NULL,
  CONSTRAINT fk_people_first_mentioned
    FOREIGN KEY (family_id, first_mentioned_event_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL,
  CONSTRAINT valid_birth_year_confidence CHECK (
    birth_year_confidence IS NULL OR birth_year_confidence IN ('high', 'medium', 'low')
  ),
  CONSTRAINT valid_death_year_confidence CHECK (
    death_year_confidence IS NULL OR death_year_confidence IN ('high', 'medium', 'low')
  )
);

COMMENT ON TABLE people IS 'People mentioned in family history (identity + optional derived summaries).';
COMMENT ON COLUMN people.birth_year IS 'Derived summary; canonical provenance lives in claims.';
COMMENT ON COLUMN people.death_year IS 'Derived summary; canonical provenance lives in claims.';
COMMENT ON COLUMN people.is_placeholder IS 'True if this person is a placeholder for an unknown individual in the family tree.';
COMMENT ON COLUMN people.superseded_by IS 'References the person this entity was merged into. NULL = current/active entity. Denormalized from entity_merges.';
COMMENT ON COLUMN people.superseded_at IS 'When this person was superseded by another. Denormalized from entity_merges.';
COMMENT ON COLUMN people.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

CREATE INDEX IF NOT EXISTS idx_people_family_name
  ON people(family_id, name);

CREATE INDEX IF NOT EXISTS idx_people_not_redacted
  ON people(family_id, redacted)
  WHERE redacted = FALSE;

CREATE INDEX IF NOT EXISTS idx_people_placeholder
  ON people(family_id, is_placeholder)
  WHERE is_placeholder = TRUE;

CREATE INDEX IF NOT EXISTS idx_people_current
  ON people(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_people_aliases_gin
  ON people USING gin(aliases);

CREATE INDEX IF NOT EXISTS idx_people_extraction_version
  ON people(extraction_version)
  WHERE extraction_version IS NOT NULL;

DROP TRIGGER IF EXISTS update_people_updated_at ON people;
CREATE TRIGGER update_people_updated_at
BEFORE UPDATE ON people
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- USERS (Global User Accounts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Optional email for account recovery/linking
  email VARCHAR(255) UNIQUE,

  -- Canonical display name and avatar
  display_name VARCHAR(255),
  avatar_url TEXT,

  -- Global role (most users will be 'user', only manual DB changes for 'super_admin')
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'super_admin')),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE users IS 'Global user accounts enabling cross-provider identity linking. Owns the global role.';
COMMENT ON COLUMN users.email IS 'Optional email for account recovery or linking multiple providers';
COMMENT ON COLUMN users.role IS 'Global role: user (default) or super_admin (manual DB setup only)';
COMMENT ON COLUMN users.display_name IS 'Canonical display name (may be synced from identities)';
COMMENT ON COLUMN users.avatar_url IS 'Canonical avatar URL (may be synced from identities)';

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users(email)
  WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Prevent non-admin users from changing their role
CREATE OR REPLACE FUNCTION prevent_user_role_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Allow role changes only if:
  -- 1. Role is not changing, OR
  -- 2. The caller is a super_admin (via JWT), OR
  -- 3. The caller is a privileged DB role (postgres, supabase_admin, service_role for migrations/tooling)
  IF OLD.role != NEW.role
     AND NOT public.is_super_admin()
     AND current_user NOT IN ('postgres', 'supabase_admin', 'service_role') THEN
    RAISE EXCEPTION 'Only super admins or privileged DB roles can change user roles.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_role_change ON users;
CREATE TRIGGER prevent_role_change
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION prevent_user_role_change();

-- ============================================================================
-- IDENTITIES (Global Provider Credentials)
-- ============================================================================
-- Unified identity table - global provider accounts, not family-scoped.
-- Each identity represents a provider account (e.g., Telegram user 12345).
-- Links to users table for cross-provider account linking.
CREATE TABLE IF NOT EXISTS identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to global user account (for cross-provider linking)
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Provider credentials
  provider VARCHAR(50) NOT NULL,               -- 'telegram', 'discord', 'whatsapp', etc.
  provider_user_id VARCHAR(255) NOT NULL,      -- ID from provider (e.g., Telegram from.id)
  provider_username VARCHAR(255),              -- Username from provider (@handle)

  -- Profile (latest known from provider)
  display_name VARCHAR(255),
  avatar_url TEXT,

  -- Auth tracking
  last_login_at TIMESTAMPTZ,

  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One identity per provider account globally
  UNIQUE (provider, provider_user_id),

  CONSTRAINT valid_identity_provider CHECK (
    provider IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  )
);

COMMENT ON TABLE identities IS
'Global provider accounts (e.g., Telegram user id). One identity per provider account, linked to users for cross-provider support.';
COMMENT ON COLUMN identities.user_id IS 'Reference to the global user account (for web auth and cross-provider linking)';
COMMENT ON COLUMN identities.provider IS 'Chat provider: telegram, discord, whatsapp, etc.';
COMMENT ON COLUMN identities.provider_user_id IS 'User ID from the chat provider';

CREATE INDEX IF NOT EXISTS idx_identities_provider_user
  ON identities(provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_identities_user_id
  ON identities(user_id)
  WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_identities_updated_at ON identities;
CREATE TRIGGER update_identities_updated_at
BEFORE UPDATE ON identities
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- FAMILY ACCESS (Per-Family Permissions + Person Claim)
-- ============================================================================
-- Controls who can access a family via the web/Studio app.
-- Also stores the user's claimed person_id in each family's genealogy.
CREATE TABLE IF NOT EXISTS family_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  -- Permissions
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),

  -- Access status
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revoked', 'suspended')),
    -- 'pending'   = chat participant, not yet authenticated for web
    -- 'active'    = authenticated, can access Studio
    -- 'revoked'   = access removed
    -- 'suspended' = temporarily disabled

  -- Person claim - who this user is in this family's genealogy (user-claimed)
  person_id UUID,

  -- How this access was granted
  granted_by VARCHAR(50) NOT NULL DEFAULT 'system'
    CHECK (granted_by IN ('chat_join', 'studio_link', 'admin', 'system', 'telegram_login', 'access_pass')),
  granted_at TIMESTAMPTZ DEFAULT NOW(),

  -- Revocation tracking
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES identities(id),
  revoke_reason TEXT,

  -- Optional notes (e.g., "Original group admin", "Invited by Maria")
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(identity_id, family_id),

  -- Composite FK enforces tenant integrity for person claim
  CONSTRAINT fk_family_access_person
    FOREIGN KEY (family_id, person_id)
    REFERENCES people(family_id, id)
    ON DELETE SET NULL
);

COMMENT ON TABLE family_access IS 'Per-family permissions and person claims. Replaces auth_identities as the per-family relationship.';
COMMENT ON COLUMN family_access.role IS 'Family-scoped role: admin (full access), member (view data), viewer (read-only)';
COMMENT ON COLUMN family_access.status IS 'Access status: pending (chat user), active (web authenticated), revoked, suspended';
COMMENT ON COLUMN family_access.person_id IS 'User-claimed identity: who this user is in this family genealogy';
COMMENT ON COLUMN family_access.granted_by IS 'How access was granted: chat_join, studio_link, admin, system, telegram_login, access_pass';

CREATE INDEX IF NOT EXISTS idx_family_access_identity
  ON family_access(identity_id);

CREATE INDEX IF NOT EXISTS idx_family_access_family
  ON family_access(family_id);

CREATE INDEX IF NOT EXISTS idx_family_access_family_role
  ON family_access(family_id, role)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_family_access_family_status
  ON family_access(family_id, status);

-- RLS performance: hot path for get_user_family_ids() function
CREATE INDEX IF NOT EXISTS idx_family_access_identity_status
  ON family_access(identity_id, status, family_id);

CREATE INDEX IF NOT EXISTS idx_family_access_person
  ON family_access(family_id, person_id)
  WHERE person_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_family_access_updated_at ON family_access;
CREATE TRIGGER update_family_access_updated_at
BEFORE UPDATE ON family_access
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- RELATIONSHIPS (Explicit edges)
-- ============================================================================
CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  person_a_id UUID NOT NULL,
  person_b_id UUID NOT NULL,

  -- Relationship type: 'parent', 'spouse', 'guardian', 'godparent', 'mentor', 'friend', etc.
  -- For 'parent': person_a is parent, person_b is child
  -- For 'spouse': order normalized by UUID
  -- For others: person_a is role-holder, person_b is recipient
  relationship_type VARCHAR(50) NOT NULL,

  -- Category distinguishes the nature of the relationship
  -- 'biological': blood relations
  -- 'legal': adoption, marriage, legal guardianship
  -- 'functional': raised by, de facto guardian
  -- 'honorary': godparent, "uncle" by respect, padrino
  -- 'social': family friend, mentor, best friend
  category VARCHAR(20) DEFAULT 'biological',

  -- Status of the relationship
  -- 'active': currently active
  -- 'ended': divorced, separated, estranged
  -- 'deceased': ended due to death
  status VARCHAR(20) DEFAULT 'active',

  -- Qualifier for nuance: 'half', 'step', 'adoptive', 'maternal', 'paternal', etc.
  qualifier VARCHAR(30),

  confidence VARCHAR(20) DEFAULT 'medium',

  conversation_event_id UUID,
  claimed_by VARCHAR(255),

  description_original TEXT,
  language_original VARCHAR(10),

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT no_self_relationship CHECK (person_a_id != person_b_id),

  -- Prevent duplicate relationships (same people, type, and qualifier)
  CONSTRAINT uq_relationships_unique UNIQUE (family_id, person_a_id, person_b_id, relationship_type, qualifier),

  CONSTRAINT valid_relationship_category CHECK (
    category IS NULL OR category IN ('biological', 'legal', 'functional', 'honorary', 'social')
  ),
  CONSTRAINT valid_relationship_status CHECK (
    status IS NULL OR status IN ('active', 'ended', 'deceased')
  ),
  CONSTRAINT valid_relationship_confidence CHECK (
    confidence IS NULL OR confidence IN ('high', 'medium', 'low')
  ),

  -- Composite FKs enforce tenant integrity
  CONSTRAINT fk_relationships_person_a
    FOREIGN KEY (family_id, person_a_id) REFERENCES people(family_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_relationships_person_b
    FOREIGN KEY (family_id, person_b_id) REFERENCES people(family_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_relationships_conversation_event
    FOREIGN KEY (family_id, conversation_event_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL
);

COMMENT ON TABLE relationships IS 'Relationships between people. Parent+spouse form the family tree backbone; others are narrative relationships.';
COMMENT ON COLUMN relationships.relationship_type IS 'Type: parent, spouse, guardian, godparent, mentor, friend, etc.';
COMMENT ON COLUMN relationships.category IS 'Category: biological, legal, functional, honorary, social';
COMMENT ON COLUMN relationships.status IS 'Status: active, ended, deceased';
COMMENT ON COLUMN relationships.qualifier IS 'Qualifier: half, step, adoptive, maternal, paternal, etc.';
COMMENT ON COLUMN relationships.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

CREATE INDEX IF NOT EXISTS idx_relationships_family
  ON relationships(family_id);

CREATE INDEX IF NOT EXISTS idx_relationships_person_a
  ON relationships(family_id, person_a_id);

CREATE INDEX IF NOT EXISTS idx_relationships_person_b
  ON relationships(family_id, person_b_id);

CREATE INDEX IF NOT EXISTS idx_relationships_category
  ON relationships(family_id, category);

CREATE INDEX IF NOT EXISTS idx_relationships_tree
  ON relationships(family_id, category)
  WHERE category IN ('biological', 'legal');

CREATE INDEX IF NOT EXISTS idx_relationships_extraction_version
  ON relationships(extraction_version)
  WHERE extraction_version IS NOT NULL;

DROP TRIGGER IF EXISTS update_relationships_updated_at ON relationships;
CREATE TRIGGER update_relationships_updated_at
BEFORE UPDATE ON relationships
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- PLACES
-- ============================================================================
CREATE TABLE IF NOT EXISTS places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  name VARCHAR(255) NOT NULL,
  type VARCHAR(50),                            -- 'city','country','address','region','landmark'

  city VARCHAR(255),
  region VARCHAR(255),
  country VARCHAR(255),

  context_original TEXT,
  language_original VARCHAR(10),

  first_mentioned_event_id UUID,

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  -- Entity merge tracking (denormalized from entity_merges for query performance)
  superseded_by UUID,
  superseded_at TIMESTAMPTZ,

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_places_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_places_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES places(family_id, id) ON DELETE SET NULL,
  CONSTRAINT fk_places_first_mentioned
    FOREIGN KEY (family_id, first_mentioned_event_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL,
  CONSTRAINT valid_place_type CHECK (
    type IS NULL OR type IN ('city', 'country', 'address', 'region', 'landmark', 'neighborhood', 'building')
  )
);

COMMENT ON TABLE places IS 'Geographic locations mentioned in stories.';
COMMENT ON COLUMN places.superseded_by IS 'References the place this entity was merged into. NULL = current/active entity. Denormalized from entity_merges.';
COMMENT ON COLUMN places.superseded_at IS 'When this place was superseded by another. Denormalized from entity_merges.';
COMMENT ON COLUMN places.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

CREATE INDEX IF NOT EXISTS idx_places_family_name
  ON places(family_id, name);

CREATE INDEX IF NOT EXISTS idx_places_family_country
  ON places(family_id, country);

CREATE INDEX IF NOT EXISTS idx_places_current
  ON places(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_places_extraction_version
  ON places(extraction_version)
  WHERE extraction_version IS NOT NULL;

DROP TRIGGER IF EXISTS update_places_updated_at ON places;
CREATE TRIGGER update_places_updated_at
BEFORE UPDATE ON places
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- EVENTS (Timeline)
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  title VARCHAR(500) NOT NULL,
  event_type VARCHAR(50),                      -- 'immigration','birth','death','marriage','business'

  description_original TEXT,
  description_language VARCHAR(10),

  -- Temporal (as claims; these are derived summaries)
  date_text VARCHAR(255),                       -- Original: "summer 1920", "around 1889"
  date_year INTEGER,                            -- Extracted for queries (nullable)

  -- Connections (use event_people join table for people)
  place_id UUID,

  -- Source
  conversation_event_id UUID,
  claimed_by VARCHAR(255),

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  -- Entity merge tracking (denormalized from entity_merges for query performance)
  superseded_by UUID,
  superseded_at TIMESTAMPTZ,

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_events_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_events_place_family
    FOREIGN KEY (family_id, place_id)
    REFERENCES places(family_id, id)
    ON DELETE SET NULL,
  CONSTRAINT fk_events_conversation_event
    FOREIGN KEY (family_id, conversation_event_id)
    REFERENCES conversation_events(family_id, id)
    ON DELETE SET NULL,
  CONSTRAINT fk_events_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES events(family_id, id) ON DELETE SET NULL
);

COMMENT ON TABLE events IS 'Atomic timeline facts: single point-in-time occurrences (birth, marriage, immigration, etc.). Structured and queryable by date/place/type. For narrative context connecting multiple events/people/places, use stories table.';
COMMENT ON COLUMN events.superseded_by IS 'References the event this entity was merged into. NULL = current/active entity. Denormalized from entity_merges.';
COMMENT ON COLUMN events.superseded_at IS 'When this event was superseded by another. Denormalized from entity_merges.';
COMMENT ON COLUMN events.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

CREATE INDEX IF NOT EXISTS idx_events_family_year
  ON events(family_id, date_year);

CREATE INDEX IF NOT EXISTS idx_events_family_type
  ON events(family_id, event_type);

CREATE INDEX IF NOT EXISTS idx_events_current
  ON events(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_extraction_version
  ON events(extraction_version)
  WHERE extraction_version IS NOT NULL;

DROP TRIGGER IF EXISTS update_events_updated_at ON events;
CREATE TRIGGER update_events_updated_at
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- EVENT PEOPLE (Many-to-Many: Events ↔ People)
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_people (
  family_id UUID NOT NULL,
  event_id UUID NOT NULL,
  person_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, event_id, person_id),

  CONSTRAINT fk_event_people_event
    FOREIGN KEY (family_id, event_id) REFERENCES events(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_event_people_person
    FOREIGN KEY (family_id, person_id) REFERENCES people(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE event_people IS 'Many-to-many: events ↔ people. Replaces events.people_involved array.';

CREATE INDEX IF NOT EXISTS idx_event_people_event
  ON event_people(family_id, event_id);

CREATE INDEX IF NOT EXISTS idx_event_people_person
  ON event_people(family_id, person_id);

-- ============================================================================
-- EVENT PLACES (Many-to-Many: Events ↔ Places)
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_places (
  family_id UUID NOT NULL,
  event_id UUID NOT NULL,
  place_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, event_id, place_id),

  CONSTRAINT fk_event_places_event
    FOREIGN KEY (family_id, event_id) REFERENCES events(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_event_places_place
    FOREIGN KEY (family_id, place_id) REFERENCES places(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE event_places IS 'Many-to-many: events ↔ places (for location context).';

CREATE INDEX IF NOT EXISTS idx_event_places_event
  ON event_places(family_id, event_id);

CREATE INDEX IF NOT EXISTS idx_event_places_place
  ON event_places(family_id, place_id);

-- ============================================================================
-- STORIES (Narrative Fragments)
-- ============================================================================
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  title VARCHAR(500),

  content_original TEXT NOT NULL,
  content_language VARCHAR(10) NOT NULL,

  themes TEXT[],
  timeframe VARCHAR(255),
  completeness VARCHAR(20) DEFAULT 'partial',  -- 'partial','complete','fragmentary'
  confidence VARCHAR(20) DEFAULT 'medium',

  -- Connections (use story_people/story_places/story_events join tables)

  -- Provenance (use story_conversation_events join table for source conversation events)
  shared_by VARCHAR(255),

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  -- Entity merge tracking (denormalized from entity_merges for query performance)
  superseded_by UUID,
  superseded_at TIMESTAMPTZ,

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_stories_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_stories_superseded_by
    FOREIGN KEY (family_id, superseded_by) REFERENCES stories(family_id, id) ON DELETE SET NULL,
  CONSTRAINT valid_story_completeness CHECK (
    completeness IS NULL OR completeness IN ('partial', 'complete', 'fragmentary')
  ),
  CONSTRAINT valid_story_confidence CHECK (
    confidence IS NULL OR confidence IN ('high', 'medium', 'low')
  )
);

COMMENT ON TABLE stories IS 'Multi-entity narrative arcs that connect people, places, and events. Use for storytelling that weaves together multiple timeline points. Single-event descriptions go in events.description_original instead. Stories typically reference 2+ entities via story_people/story_places/story_events.';
COMMENT ON COLUMN stories.superseded_by IS 'References the story this entity was merged into. NULL = current/active entity. Denormalized from entity_merges.';
COMMENT ON COLUMN stories.superseded_at IS 'When this story was superseded by another. Denormalized from entity_merges.';
COMMENT ON COLUMN stories.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

CREATE INDEX IF NOT EXISTS idx_stories_family_timeframe
  ON stories(family_id, timeframe);

CREATE INDEX IF NOT EXISTS idx_stories_not_redacted
  ON stories(family_id, redacted)
  WHERE redacted = FALSE;

CREATE INDEX IF NOT EXISTS idx_stories_current
  ON stories(family_id)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_stories_extraction_version
  ON stories(extraction_version)
  WHERE extraction_version IS NOT NULL;

DROP TRIGGER IF EXISTS update_stories_updated_at ON stories;
CREATE TRIGGER update_stories_updated_at
BEFORE UPDATE ON stories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- STORY PEOPLE (Many-to-Many: Stories ↔ People)
-- ============================================================================
CREATE TABLE IF NOT EXISTS story_people (
  family_id UUID NOT NULL,
  story_id UUID NOT NULL,
  person_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, story_id, person_id),

  CONSTRAINT fk_story_people_story
    FOREIGN KEY (family_id, story_id) REFERENCES stories(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_story_people_person
    FOREIGN KEY (family_id, person_id) REFERENCES people(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE story_people IS 'Many-to-many: stories ↔ people. Replaces stories.people array.';

CREATE INDEX IF NOT EXISTS idx_story_people_story
  ON story_people(family_id, story_id);

CREATE INDEX IF NOT EXISTS idx_story_people_person
  ON story_people(family_id, person_id);

-- ============================================================================
-- STORY PLACES (Many-to-Many: Stories ↔ Places)
-- ============================================================================
CREATE TABLE IF NOT EXISTS story_places (
  family_id UUID NOT NULL,
  story_id UUID NOT NULL,
  place_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, story_id, place_id),

  CONSTRAINT fk_story_places_story
    FOREIGN KEY (family_id, story_id) REFERENCES stories(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_story_places_place
    FOREIGN KEY (family_id, place_id) REFERENCES places(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE story_places IS 'Many-to-many: stories ↔ places. Replaces stories.places array.';

CREATE INDEX IF NOT EXISTS idx_story_places_story
  ON story_places(family_id, story_id);

CREATE INDEX IF NOT EXISTS idx_story_places_place
  ON story_places(family_id, place_id);

-- ============================================================================
-- STORY EVENTS (Many-to-Many: Stories ↔ Events)
-- ============================================================================
CREATE TABLE IF NOT EXISTS story_events (
  family_id UUID NOT NULL,
  story_id UUID NOT NULL,
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, story_id, event_id),

  CONSTRAINT fk_story_events_story
    FOREIGN KEY (family_id, story_id) REFERENCES stories(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_story_events_event
    FOREIGN KEY (family_id, event_id) REFERENCES events(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE story_events IS 'Many-to-many: stories ↔ events. Replaces stories.events array.';

CREATE INDEX IF NOT EXISTS idx_story_events_story
  ON story_events(family_id, story_id);

CREATE INDEX IF NOT EXISTS idx_story_events_event
  ON story_events(family_id, event_id);

-- ============================================================================
-- STORY CONVERSATION EVENTS (Provenance tracking)
-- ============================================================================
-- Many-to-many: stories ↔ conversation_events (provenance)
-- Replaces stories.source_event_ids array for consistency
CREATE TABLE IF NOT EXISTS story_conversation_events (
  family_id UUID NOT NULL,
  story_id UUID NOT NULL,
  conversation_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, story_id, conversation_event_id),

  CONSTRAINT fk_story_conversation_events_story
    FOREIGN KEY (family_id, story_id) REFERENCES stories(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_story_conversation_events_event
    FOREIGN KEY (family_id, conversation_event_id) REFERENCES conversation_events(family_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE story_conversation_events IS 'Many-to-many: stories ↔ conversation_events. Tracks which raw chat messages were used to create this story.';

CREATE INDEX IF NOT EXISTS idx_story_conversation_events_story
  ON story_conversation_events(family_id, story_id);

CREATE INDEX IF NOT EXISTS idx_story_conversation_events_event
  ON story_conversation_events(family_id, conversation_event_id);

-- ============================================================================
-- CLAIMS (Atomic provenance layer)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  claim_type VARCHAR(50) NOT NULL,             -- 'date','location','relationship','detail','identity'
  subject VARCHAR(255) NOT NULL,               -- searchable human label
  claim_value JSONB NOT NULL,                  -- flexible payload

  -- Provenance
  conversation_event_id UUID NOT NULL,
  claimed_by VARCHAR(255) NOT NULL,
  claimed_by_source VARCHAR(20) NOT NULL DEFAULT 'direct', -- 'direct','attributed','hearsay'
  claimed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Certainty
  confidence VARCHAR(20) DEFAULT 'medium',
  certainty_language TEXT,                     -- "definitely","I think","probably"

  -- Context (original language only; translate on-read)
  context_original TEXT,
  language_original VARCHAR(10),

  -- Entity association (use claim_entities join table for all entity links)

  -- Lifecycle (operational necessity - only mutable field)
  status VARCHAR(20) DEFAULT 'active',         -- 'active','superseded','disputed','redacted'

  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  -- Extraction versioning (for event sourcing)
  extraction_version VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Composite FK enforces tenant integrity
  CONSTRAINT uq_claims_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_claims_conversation_event
    FOREIGN KEY (family_id, conversation_event_id) REFERENCES conversation_events(family_id, id) ON DELETE RESTRICT,

  -- Enum-like constraints
  CONSTRAINT valid_claim_type CHECK (
    claim_type IN ('date', 'location', 'relationship', 'detail', 'identity')
  ),
  CONSTRAINT valid_claim_status CHECK (
    status IS NULL OR status IN ('active', 'superseded', 'disputed', 'redacted')
  ),
  CONSTRAINT valid_claim_confidence CHECK (
    confidence IS NULL OR confidence IN ('high', 'medium', 'low')
  ),
  CONSTRAINT valid_claimed_by_source CHECK (
    claimed_by_source IN ('direct', 'attributed', 'hearsay')
  )
);

COMMENT ON TABLE claims IS 'Atomic factual claims with full provenance (canonical truth layer).';
COMMENT ON COLUMN claims.conversation_event_id IS 'Reference to the conversation event where this claim originated';
COMMENT ON COLUMN claims.extraction_version IS 'Version of extraction logic that created this record (e.g., scribe-v1.0.0). For event sourcing.';

DROP TRIGGER IF EXISTS update_claims_updated_at ON claims;
CREATE TRIGGER update_claims_updated_at
BEFORE UPDATE ON claims
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_claims_family_type
  ON claims(family_id, claim_type);

CREATE INDEX IF NOT EXISTS idx_claims_family_subject
  ON claims(family_id, subject);

-- Note: Entity associations now in claim_entities join table

CREATE INDEX IF NOT EXISTS idx_claims_family_conversation_event
  ON claims(family_id, conversation_event_id);

CREATE INDEX IF NOT EXISTS idx_claims_active
  ON claims(family_id, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_claims_family_source_type
  ON claims(family_id, claimed_by_source);

CREATE INDEX IF NOT EXISTS idx_claims_extraction_version
  ON claims(extraction_version)
  WHERE extraction_version IS NOT NULL;

-- ============================================================================
-- CLAIM ANALYSIS (System-computed metadata, separated from immutable provenance)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claim_analysis (
  claim_id UUID PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  -- Analysis metadata
  inference_method VARCHAR(50),                -- 'direct', 'logical_inference', 'llm_inference'
  claim_strength DECIMAL(3,2) DEFAULT 0.50,    -- 0.00 to 1.00 (system confidence)
  strength_factors JSONB,                      -- Complete breakdown for auditability
  needs_llm_evaluation BOOLEAN DEFAULT FALSE,  -- Flag: should this be queued for LLM review?

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_inference_method CHECK (
    inference_method IS NULL OR inference_method IN ('direct', 'logical_inference', 'llm_inference')
  ),
  CONSTRAINT valid_claim_strength CHECK (
    claim_strength IS NULL OR (claim_strength >= 0.00 AND claim_strength <= 1.00)
  ),

  -- Composite FK enforces tenant integrity
  CONSTRAINT fk_claim_analysis_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE claim_analysis IS 'System-computed analysis for claims. Separated from immutable claim provenance. Can be recomputed without touching source claims.';

DROP TRIGGER IF EXISTS update_claim_analysis_updated_at ON claim_analysis;
CREATE TRIGGER update_claim_analysis_updated_at
BEFORE UPDATE ON claim_analysis
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_claim_analysis_family
  ON claim_analysis(family_id);

CREATE INDEX IF NOT EXISTS idx_claim_analysis_needs_llm
  ON claim_analysis(family_id, needs_llm_evaluation)
  WHERE needs_llm_evaluation = TRUE;

-- ============================================================================
-- CLAIM CONFLICTS (Explicit preservation, graph-friendly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claim_conflicts (
  family_id UUID NOT NULL REFERENCES families(id),
  claim_id UUID NOT NULL,
  conflicts_with_claim_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (family_id, claim_id, conflicts_with_claim_id),
  CONSTRAINT no_self_conflict CHECK (claim_id != conflicts_with_claim_id),

  -- Composite FKs enforce tenant integrity
  CONSTRAINT fk_claim_conflicts_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_conflicts_with
    FOREIGN KEY (family_id, conflicts_with_claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE claim_conflicts IS 'Explicit links between conflicting claims (never resolved). Cascades delete when either claim is removed.';

CREATE INDEX IF NOT EXISTS idx_claim_conflicts_family_claim
  ON claim_conflicts(family_id, claim_id);

-- ============================================================================
-- ENTITY MERGES (Active merge tracking)
-- ============================================================================
-- Tracks active entity merges with full provenance
-- Mutable and deletable - delete to undo merge (provenance preserved in claims)
-- superseded_by columns on entity tables are denormalized cache from this table
CREATE TABLE IF NOT EXISTS entity_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  -- Polymorphic source entity (the one being merged away)
  source_entity_id UUID NOT NULL,
  source_entity_type VARCHAR(50) NOT NULL, -- 'person', 'place', 'event', 'story'

  -- Polymorphic target entity (the one kept)
  target_entity_id UUID NOT NULL,
  target_entity_type VARCHAR(50) NOT NULL,

  -- Merge metadata
  merge_strategy VARCHAR(50),              -- 'fuzzy_match', 'identity_claim', 'manual', 'llm_resolved'
  confidence DECIMAL(3,2),                 -- 0.00 to 1.00
  trigger_event_id UUID,

  -- Provenance
  merged_by VARCHAR(50),                   -- 'registrar', 'curator', 'admin', 'llm_resolver'
  merge_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Note: 'relationship' is intentionally excluded - relationships are edges, not mergeable nodes
  CONSTRAINT valid_entity_types CHECK (
    source_entity_type IN ('person', 'place', 'event', 'story') AND
    target_entity_type IN ('person', 'place', 'event', 'story')
  ),
  CONSTRAINT same_entity_type CHECK (source_entity_type = target_entity_type),
  CONSTRAINT no_self_merge CHECK (source_entity_id <> target_entity_id),
  CONSTRAINT valid_merge_strategy CHECK (
    merge_strategy IS NULL OR merge_strategy IN ('fuzzy_match', 'identity_claim', 'manual', 'llm_resolved', 'dedupe')
  ),
  CONSTRAINT valid_merged_by CHECK (
    merged_by IS NULL OR merged_by IN ('registrar', 'curator', 'admin', 'llm_resolver', 'system')
  ),

  -- Composite FK and UNIQUE for tenant integrity
  CONSTRAINT uq_entity_merges_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_entity_merges_trigger_event
    FOREIGN KEY (family_id, trigger_event_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL
);

COMMENT ON TABLE entity_merges IS 'Active entity merges. Delete record to undo merge. superseded_by columns are denormalized cache.';
COMMENT ON COLUMN entity_merges.merge_strategy IS 'How merge was determined: fuzzy_match, identity_claim, manual, llm_resolved';
COMMENT ON COLUMN entity_merges.confidence IS 'Merge confidence 0.00-1.00. High confidence (>0.9) merges created automatically.';
COMMENT ON COLUMN entity_merges.merge_reason IS 'Human-readable explanation of why entities were merged';

-- Only one active merge per source entity (prevents ambiguous A→B and A→C)
-- Note: This unique index also serves as the lookup index for source entities
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_merges_unique_source
  ON entity_merges(family_id, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_merges_target
  ON entity_merges(family_id, target_entity_type, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_merges_family
  ON entity_merges(family_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Prevent circular merges (A→B→C→A)
-- ----------------------------------------------------------------------------
-- Traverses entity_merges table (NOT denormalized superseded_by columns)
-- This ensures cycle detection is consistent even if superseded_by is out of sync
CREATE OR REPLACE FUNCTION prevent_circular_merges()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if target entity is already in the merge chain leading to source
  -- This prevents cycles like A→B→C→A
  IF EXISTS (
    WITH RECURSIVE merge_chain AS (
      -- Start from the target entity
      SELECT NEW.target_entity_id as entity_id, 1 as depth
      UNION ALL
      -- Follow the merge chain: find where this entity was merged TO
      SELECT em.target_entity_id, mc.depth + 1
      FROM public.entity_merges em
      JOIN merge_chain mc ON em.source_entity_id = mc.entity_id
      WHERE em.family_id = NEW.family_id
        AND em.source_entity_type = NEW.source_entity_type
        AND mc.depth < 100  -- Depth limit for safety
    )
    SELECT 1 FROM merge_chain WHERE entity_id = NEW.source_entity_id
  ) THEN
    RAISE EXCEPTION 'Circular merge detected: would create cycle in % merge chain', NEW.source_entity_type;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_circular_merges IS 'Prevents circular entity merge chains (A→B→C→A). Traverses entity_merges table for consistency.';

DROP TRIGGER IF EXISTS check_circular_merges ON entity_merges;
CREATE TRIGGER check_circular_merges
  BEFORE INSERT ON entity_merges
  FOR EACH ROW
  EXECUTE FUNCTION prevent_circular_merges();

-- ----------------------------------------------------------------------------
-- Enforce tenant integrity for trigger_event_id
-- ----------------------------------------------------------------------------
-- Validates trigger_event_id belongs to same family without composite FK overhead
CREATE OR REPLACE FUNCTION validate_entity_merge_trigger_event()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.trigger_event_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversation_events
      WHERE id = NEW.trigger_event_id AND family_id = NEW.family_id
    ) THEN
      RAISE EXCEPTION 'trigger_event_id must reference an event in the same family';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION validate_entity_merge_trigger_event IS 'Validates trigger_event_id belongs to same family as merge';

DROP TRIGGER IF EXISTS check_entity_merge_trigger_event ON entity_merges;
CREATE TRIGGER check_entity_merge_trigger_event
  BEFORE INSERT OR UPDATE ON entity_merges
  FOR EACH ROW
  EXECUTE FUNCTION validate_entity_merge_trigger_event();

-- ----------------------------------------------------------------------------
-- Validate polymorphic entity references for tenant integrity
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION validate_entity_merge_references()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_family_id UUID;
  target_family_id UUID;
BEGIN
  -- Validate source entity exists and get its family_id
  CASE NEW.source_entity_type
    WHEN 'person' THEN
      SELECT family_id INTO source_family_id
      FROM public.people WHERE id = NEW.source_entity_id;
    WHEN 'place' THEN
      SELECT family_id INTO source_family_id
      FROM public.places WHERE id = NEW.source_entity_id;
    WHEN 'event' THEN
      SELECT family_id INTO source_family_id
      FROM public.events WHERE id = NEW.source_entity_id;
    WHEN 'story' THEN
      SELECT family_id INTO source_family_id
      FROM public.stories WHERE id = NEW.source_entity_id;
    ELSE
      RAISE EXCEPTION 'Invalid source_entity_type: %', NEW.source_entity_type;
  END CASE;

  -- Check source entity exists (SELECT INTO sets variable to NULL if no row found)
  IF source_family_id IS NULL THEN
    RAISE EXCEPTION 'Source entity % of type % does not exist',
      NEW.source_entity_id, NEW.source_entity_type;
  END IF;

  -- Validate target entity exists and get its family_id
  CASE NEW.target_entity_type
    WHEN 'person' THEN
      SELECT family_id INTO target_family_id
      FROM public.people WHERE id = NEW.target_entity_id;
    WHEN 'place' THEN
      SELECT family_id INTO target_family_id
      FROM public.places WHERE id = NEW.target_entity_id;
    WHEN 'event' THEN
      SELECT family_id INTO target_family_id
      FROM public.events WHERE id = NEW.target_entity_id;
    WHEN 'story' THEN
      SELECT family_id INTO target_family_id
      FROM public.stories WHERE id = NEW.target_entity_id;
    ELSE
      RAISE EXCEPTION 'Invalid target_entity_type: %', NEW.target_entity_type;
  END CASE;

  -- Check target entity exists
  IF target_family_id IS NULL THEN
    RAISE EXCEPTION 'Target entity % of type % does not exist',
      NEW.target_entity_id, NEW.target_entity_type;
  END IF;

  -- Check source family_id matches (tenant integrity)
  IF source_family_id != NEW.family_id THEN
    RAISE EXCEPTION 'Source entity % belongs to family %, but merge has family_id %',
      NEW.source_entity_id, source_family_id, NEW.family_id
      USING HINT = 'Tenant integrity violation - source entity must belong to same family as merge';
  END IF;

  -- Check target family_id matches (tenant integrity)
  IF target_family_id != NEW.family_id THEN
    RAISE EXCEPTION 'Target entity % belongs to family %, but merge has family_id %',
      NEW.target_entity_id, target_family_id, NEW.family_id
      USING HINT = 'Tenant integrity violation - target entity must belong to same family as merge';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_entity_merge_references ON entity_merges;
CREATE TRIGGER validate_entity_merge_references
  BEFORE INSERT OR UPDATE ON entity_merges
  FOR EACH ROW
  EXECUTE FUNCTION validate_entity_merge_references();

COMMENT ON FUNCTION validate_entity_merge_references IS 'Validates polymorphic entity merge references exist and match family_id for tenant integrity';

-- ----------------------------------------------------------------------------
-- Get entity merge chain helper
-- ----------------------------------------------------------------------------
-- Returns all entity IDs in a merge chain (entity + all merged predecessors)
-- Traverses entity_merges table for consistency (not denormalized superseded_by)
-- Used for querying claims across merged entities
CREATE OR REPLACE FUNCTION get_entity_merge_chain(
  p_entity_id UUID,
  p_entity_type VARCHAR(50),  -- 'person', 'place', 'event', 'story'
  p_family_id UUID
) RETURNS TABLE(entity_id UUID) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE merge_chain AS (
    -- Start with the target entity
    SELECT p_entity_id as id, 1 as depth
    UNION ALL
    -- Find all entities that were merged INTO the current chain
    -- (i.e., source entities whose target is in our chain)
    SELECT em.source_entity_id, mc.depth + 1
    FROM public.entity_merges em
    JOIN merge_chain mc ON em.target_entity_id = mc.id
    WHERE em.family_id = p_family_id
      AND em.source_entity_type = p_entity_type
      AND em.target_entity_type = p_entity_type
      AND mc.depth < 100  -- Depth limit for safety (matches cycle prevention)
  )
  SELECT id FROM merge_chain;
END;
$$ LANGUAGE plpgsql STABLE
SET search_path = '';

COMMENT ON FUNCTION get_entity_merge_chain IS 'Returns all entity IDs in merge chain (entity + merged predecessors). Used for querying claims across merges.';

-- ============================================================================
-- PHASE 1C: CLAIMS ENHANCEMENT ARCHITECTURE
-- ============================================================================

-- Note: claims table already has composite unique constraint (family_id, id)
-- defined inline, so no additional ALTER TABLE needed

-- ============================================================================
-- CLAIM ENTITIES (Many-to-many with identity resolution support)
-- ============================================================================
-- Join table for claims and entities
-- Hybrid design: typed columns for queryable fields + JSONB for extensibility
-- Identity resolution: Uses parent claims.claim_type='identity' as discriminator
CREATE TABLE IF NOT EXISTS claim_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL,
  claim_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,  -- 'person', 'place', 'event', 'story', 'relationship'

  -- Relationship metadata
  role VARCHAR(50),                   -- 'subject', 'related', 'identity_source', 'identity_target', 'location', 'witness'

  -- Identity resolution fields (NULL for non-identity relationships)
  -- Note: Identity status determined by parent claims.claim_type, not a flag here
  resolved BOOLEAN,
  entity_merge_id UUID,

  -- Extended metadata for specialized relationship types (JSONB)
  -- For identity claims: {"descriptive_name": "...", "canonical_name": "..."}
  -- For temporal claims: {"temporal_order": 1}
  -- For hierarchical claims: {"hierarchy_level": "city"}
  relationship_metadata JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint allows same entity in different roles for one claim
  UNIQUE (family_id, claim_id, entity_id, entity_type, role),

  -- Composite FKs enforce tenant integrity at DB level (family_id must match)
  CONSTRAINT fk_claim_entities_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_entities_merge
    FOREIGN KEY (family_id, entity_merge_id) REFERENCES entity_merges(family_id, id) ON DELETE SET NULL,

  CONSTRAINT valid_entity_types CHECK (
    entity_type IN ('person', 'place', 'event', 'story', 'relationship')
  ),
  CONSTRAINT valid_claim_entity_role CHECK (
    role IS NULL OR role IN ('subject', 'related', 'identity_source', 'identity_target', 'location', 'witness')
  )
);

COMMENT ON TABLE claim_entities IS 'Many-to-many claim-entity relationships. Typed role column for semantics + JSONB for extensibility.';
COMMENT ON COLUMN claim_entities.role IS 'Entity role in claim: subject (main entity), related (secondary entity), identity_source/identity_target (for identity claims), location, witness';
COMMENT ON COLUMN claim_entities.resolved IS 'For identity claims only: whether identity has been resolved via merge';
COMMENT ON COLUMN claim_entities.entity_merge_id IS 'Links to merge decision for identity claims. ON DELETE SET NULL when merge undone.';
COMMENT ON COLUMN claim_entities.relationship_metadata IS 'Extended metadata (JSONB). Identity: descriptive_name, canonical_name. Future: temporal_order, hierarchy_level.';

CREATE INDEX IF NOT EXISTS idx_claim_entities_family
  ON claim_entities(family_id);

CREATE INDEX IF NOT EXISTS idx_claim_entities_entity
  ON claim_entities(family_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_claim_entities_claim
  ON claim_entities(family_id, claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_entities_role
  ON claim_entities(family_id, role)
  WHERE role IS NOT NULL;

-- Fast lookup for unresolved identity claims (uses claim_id to join to claims)
CREATE INDEX IF NOT EXISTS idx_claim_entities_resolved
  ON claim_entities(family_id, resolved)
  WHERE resolved = FALSE;

-- JSONB index for metadata queries (optional, add if needed)
CREATE INDEX IF NOT EXISTS idx_claim_entities_metadata_gin
  ON claim_entities USING gin(relationship_metadata);

-- Validate polymorphic entity references for tenant integrity
CREATE OR REPLACE FUNCTION validate_claim_entity_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  entity_family_id UUID;
BEGIN
  -- Validate that entity exists and belongs to the same family
  CASE NEW.entity_type
    WHEN 'person' THEN
      SELECT family_id INTO entity_family_id
      FROM public.people WHERE id = NEW.entity_id;
    WHEN 'place' THEN
      SELECT family_id INTO entity_family_id
      FROM public.places WHERE id = NEW.entity_id;
    WHEN 'event' THEN
      SELECT family_id INTO entity_family_id
      FROM public.events WHERE id = NEW.entity_id;
    WHEN 'story' THEN
      SELECT family_id INTO entity_family_id
      FROM public.stories WHERE id = NEW.entity_id;
    WHEN 'relationship' THEN
      SELECT family_id INTO entity_family_id
      FROM public.relationships WHERE id = NEW.entity_id;
    ELSE
      RAISE EXCEPTION 'Invalid entity_type: %', NEW.entity_type;
  END CASE;

  -- Check entity exists (SELECT INTO sets variable to NULL if no row found)
  IF entity_family_id IS NULL THEN
    RAISE EXCEPTION 'Entity % of type % does not exist', NEW.entity_id, NEW.entity_type;
  END IF;

  -- Check family_id matches (tenant integrity)
  IF entity_family_id != NEW.family_id THEN
    RAISE EXCEPTION 'Entity % belongs to family %, but claim_entity has family_id %',
      NEW.entity_id, entity_family_id, NEW.family_id
      USING HINT = 'Tenant integrity violation - entity must belong to same family as claim';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_claim_entity_reference ON claim_entities;
CREATE TRIGGER validate_claim_entity_reference
  BEFORE INSERT OR UPDATE ON claim_entities
  FOR EACH ROW
  EXECUTE FUNCTION validate_claim_entity_reference();

COMMENT ON FUNCTION validate_claim_entity_reference IS 'Validates polymorphic entity references exist and match family_id for tenant integrity';

-- ============================================================================
-- CLAIM RELATIONSHIPS (Supports, contradicts, refines, supersedes, derived_from)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claim_relationships (
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL,
  related_claim_id UUID NOT NULL,
  relationship_type VARCHAR(50) NOT NULL,  -- 'supports', 'contradicts', 'refines', 'supersedes', 'derived_from'

  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (family_id, claim_id, related_claim_id, relationship_type),

  -- Composite FKs enforce tenant integrity (both claims must belong to same family)
  CONSTRAINT fk_claim_relationships_claim
    FOREIGN KEY (family_id, claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_claim_relationships_related
    FOREIGN KEY (family_id, related_claim_id) REFERENCES claims(family_id, id) ON DELETE CASCADE,

  CONSTRAINT no_self_relation CHECK (claim_id != related_claim_id),
  CONSTRAINT valid_claim_relationship_type CHECK (
    relationship_type IN ('supports', 'contradicts', 'refines', 'supersedes', 'derived_from')
  )
);

COMMENT ON TABLE claim_relationships IS 'Links between claims: supports, contradicts, refines, supersedes, derived_from. Enables argument graphs and inference chains.';
COMMENT ON COLUMN claim_relationships.relationship_type IS 'supports=confirming evidence, contradicts=conflicting, refines=more specific, supersedes=replaces, derived_from=inferred';

CREATE INDEX IF NOT EXISTS idx_claim_relationships_claim
  ON claim_relationships(family_id, claim_id);

-- Reverse lookup: "find claims that support/contradict this claim"
CREATE INDEX IF NOT EXISTS idx_claim_relationships_related
  ON claim_relationships(family_id, related_claim_id);

-- ============================================================================
-- LLM EVALUATION QUEUE
-- ============================================================================

CREATE TABLE IF NOT EXISTS llm_evaluation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,

  -- What to evaluate
  evaluation_type VARCHAR(50) NOT NULL,  -- 'claim_strength', 'entity_match', 'conflict_resolution'
  entity_type VARCHAR(50) NOT NULL,      -- 'claim', 'person', 'place', 'event', 'story'
  entity_id UUID NOT NULL,               -- ID of the entity to evaluate

  -- Priority and context
  priority INTEGER DEFAULT 0,            -- Higher = more urgent (0-100)
  context JSONB,                         -- Additional context needed for evaluation

  -- Queue management
  status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'locked', 'completed', 'failed', 'cancelled'
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  locked_until TIMESTAMPTZ,              -- Lock expiration (auto-cleanup)
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  max_attempts INTEGER DEFAULT 3,

  -- Results
  completed_at TIMESTAMPTZ,
  processing_time_ms INTEGER,            -- Track performance
  result JSONB,                          -- Evaluation result

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_evaluation_type CHECK (
    evaluation_type IN ('claim_strength', 'entity_match', 'conflict_resolution')
  ),
  CONSTRAINT valid_queue_status CHECK (
    status IN ('pending', 'locked', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT valid_priority CHECK (priority >= 0 AND priority <= 100)
);

COMMENT ON TABLE llm_evaluation_queue IS 'Queue for LLM evaluation tasks (claim strength, entity matching, conflict resolution). Supports prioritization, distributed processing with locks, and retry logic.';
COMMENT ON COLUMN llm_evaluation_queue.priority IS '0-100, higher = more urgent. High-stakes claims (birth/death) get priority 100.';
COMMENT ON COLUMN llm_evaluation_queue.locked_until IS 'Lock expiration time. Auto-cleanup via cleanup_expired_evaluation_locks() function.';

-- Efficient query for workers to acquire pending items
CREATE INDEX IF NOT EXISTS idx_llm_queue_pending
  ON llm_evaluation_queue(family_id, status, priority DESC, created_at)
  WHERE status = 'pending';

-- Cleanup expired locks
CREATE INDEX IF NOT EXISTS idx_llm_queue_expired_locks
  ON llm_evaluation_queue(locked_until)
  WHERE status = 'locked';

-- Lookup by entity
CREATE INDEX IF NOT EXISTS idx_llm_queue_entity
  ON llm_evaluation_queue(entity_type, entity_id);

-- Stats and monitoring
CREATE INDEX IF NOT EXISTS idx_llm_queue_stats
  ON llm_evaluation_queue(family_id, status, created_at);

-- Auto-cleanup function for expired locks
CREATE OR REPLACE FUNCTION cleanup_expired_evaluation_locks()
RETURNS INTEGER AS $$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE llm_evaluation_queue
  SET status = 'pending',
      locked_at = NULL,
      locked_by = NULL,
      locked_until = NULL,
      updated_at = NOW()
  WHERE status = 'locked'
    AND locked_until < NOW();

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_evaluation_locks IS 'Release expired locks and return claims to pending status. Run periodically (e.g., every minute) via cron or scheduler.';

-- Auto-cleanup function for expired access passes
CREATE OR REPLACE FUNCTION cleanup_expired_access_passes()
RETURNS INTEGER AS $$
DECLARE
  rows_updated INTEGER;
BEGIN
  UPDATE access_passes
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at < NOW();

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_access_passes IS 'Mark expired pending access passes as expired. Run periodically (e.g., every hour) via cron or scheduler.';

-- ============================================================================
-- CLAIMS IMMUTABILITY (Core fields never change after creation)
-- ============================================================================
-- Immutable fields: claim_type, subject, claim_value, conversation_event_id, claimed_by,
--                   claimed_by_source, claimed_at, certainty_language, context_original,
--                   language_original
-- Mutable fields: status, confidence, updated_at

CREATE OR REPLACE FUNCTION enforce_claims_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- IS DISTINCT FROM returns FALSE when values are equal (including NULL = NULL)
  -- This allows no-op updates that don't actually change immutable fields
  IF OLD.claim_type IS DISTINCT FROM NEW.claim_type OR
     OLD.subject IS DISTINCT FROM NEW.subject OR
     OLD.claim_value IS DISTINCT FROM NEW.claim_value OR
     OLD.conversation_event_id IS DISTINCT FROM NEW.conversation_event_id OR
     OLD.claimed_by IS DISTINCT FROM NEW.claimed_by OR
     OLD.claimed_by_source IS DISTINCT FROM NEW.claimed_by_source OR
     OLD.claimed_at IS DISTINCT FROM NEW.claimed_at OR
     OLD.certainty_language IS DISTINCT FROM NEW.certainty_language OR
     OLD.context_original IS DISTINCT FROM NEW.context_original OR
     OLD.language_original IS DISTINCT FROM NEW.language_original THEN
    RAISE EXCEPTION 'Cannot modify immutable claim fields. Create a new claim instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION enforce_claims_immutability IS 'Prevents modification of core claim data. Only metadata (status, confidence) can be updated.';

DROP TRIGGER IF EXISTS enforce_claims_immutable ON claims;
CREATE TRIGGER enforce_claims_immutable
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION enforce_claims_immutability();

-- Prevent claim deletes (use status=redacted instead)
CREATE OR REPLACE FUNCTION prevent_claim_deletes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Cannot delete claims. Use status=redacted instead.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_claim_deletes IS 'Prevents claim deletion. Use status=redacted for soft delete.';

DROP TRIGGER IF EXISTS enforce_claims_no_delete ON claims;
CREATE TRIGGER enforce_claims_no_delete
  BEFORE DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION prevent_claim_deletes();

-- ============================================================================
-- END PHASE 1C
-- ============================================================================

-- ============================================================================
-- IMAGES / MEDIA
-- ============================================================================
CREATE TABLE IF NOT EXISTS images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Provider-neutral media id (often provider-specific)
  source VARCHAR(50) NOT NULL,                 -- matches conversation_events.source
  external_file_id VARCHAR(255) NOT NULL,

  file_type VARCHAR(50),                       -- 'photo','document'
  file_size_bytes INTEGER,

  caption_original TEXT,
  language_original VARCHAR(10),

  -- Analysis output (from Media Scribe)
  analysis JSONB,
  people_count INTEGER,
  estimated_era VARCHAR(50),
  visible_text TEXT[],

  -- Connections (POC-friendly arrays - no FK enforcement)
  -- Note: These arrays intentionally lack referential integrity for POC simplicity.
  -- If a story/person is deleted, stale UUIDs may remain. For production, consider
  -- using join tables (image_stories, image_people) with proper FKs.
  connected_stories UUID[],
  connected_people UUID[],

  -- Provenance
  conversation_event_id UUID NOT NULL,
  shared_by VARCHAR(255),

  analyzed BOOLEAN DEFAULT FALSE,
  analyzed_at TIMESTAMPTZ,

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_images_family_id UNIQUE (family_id, id),
  CONSTRAINT uq_images_external_file UNIQUE(family_id, source, external_file_id),

  -- Composite FK enforces tenant integrity
  CONSTRAINT fk_images_conversation_event
    FOREIGN KEY (family_id, conversation_event_id) REFERENCES conversation_events(family_id, id) ON DELETE CASCADE,

  CONSTRAINT valid_image_source CHECK (
    source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  ),
  CONSTRAINT valid_image_file_type CHECK (
    file_type IS NULL OR file_type IN ('photo', 'document', 'video', 'audio', 'voice')
  )
);

COMMENT ON TABLE images IS 'Photos and documents shared in conversations.';

CREATE INDEX IF NOT EXISTS idx_images_family_analyzed
  ON images(family_id, analyzed)
  WHERE analyzed = FALSE;

CREATE INDEX IF NOT EXISTS idx_images_family_conversation_event
  ON images(family_id, conversation_event_id);

DROP TRIGGER IF EXISTS update_images_updated_at ON images;
CREATE TRIGGER update_images_updated_at
BEFORE UPDATE ON images
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- QUESTIONS (Facilitator Queue)
-- ============================================================================
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Question text (original language only)
  content_original TEXT NOT NULL,
  language_original VARCHAR(10) NOT NULL,

  -- Origin and status
  origin TEXT NOT NULL CHECK (origin IN ('curator', 'human')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'asked', 'answered', 'retired')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),

  -- Source tracking
  source_message_id UUID NULL,
  asked_by_identity_id UUID NULL REFERENCES identities(id),

  -- When asked/answered
  asked_at TIMESTAMPTZ NULL,
  answered_at TIMESTAMPTZ NULL,
  answer_message_id UUID NULL,

  -- External message tracking (for answer detection)
  asked_external_message_id TEXT NULL,

  -- Targeting metadata (for Facilitator warmth formatting)
  target_person TEXT NULL,
  target_event TEXT NULL,
  target_place TEXT NULL,
  story_context TEXT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FKs enforce tenant integrity
  CONSTRAINT fk_questions_source_message
    FOREIGN KEY (family_id, source_message_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL,
  CONSTRAINT fk_questions_answer_message
    FOREIGN KEY (family_id, answer_message_id) REFERENCES conversation_events(family_id, id) ON DELETE SET NULL
);

COMMENT ON TABLE questions IS 'Question lifecycle managed by Facilitator.';
COMMENT ON COLUMN questions.asked_external_message_id IS 'External message ID of the sent question, for matching replies';
COMMENT ON COLUMN questions.target_person IS 'Name of the person this question should be directed to';
COMMENT ON COLUMN questions.target_event IS 'Name/title of the event this question relates to';
COMMENT ON COLUMN questions.target_place IS 'Name of the place this question relates to';
COMMENT ON COLUMN questions.story_context IS 'Brief context about the story this question aims to enrich';

CREATE INDEX IF NOT EXISTS idx_questions_family_status
  ON questions(family_id, status);

CREATE INDEX IF NOT EXISTS idx_questions_family_priority
  ON questions(family_id, status, priority DESC)
  WHERE status = 'proposed';

CREATE INDEX IF NOT EXISTS idx_questions_external_message_id
  ON questions(family_id, asked_external_message_id)
  WHERE asked_external_message_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_questions_updated_at ON questions;
CREATE TRIGGER update_questions_updated_at
BEFORE UPDATE ON questions
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Validate asked_by_identity_id has access to the question's family
CREATE OR REPLACE FUNCTION validate_question_identity_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.asked_by_identity_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.family_access
      WHERE identity_id = NEW.asked_by_identity_id
        AND family_id = NEW.family_id
        AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'asked_by_identity_id % does not have active access to family %',
        NEW.asked_by_identity_id, NEW.family_id
        USING HINT = 'Identity must have active family_access to be associated with a question';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION validate_question_identity_access IS 'Validates asked_by_identity_id has active access to the question family';

DROP TRIGGER IF EXISTS validate_question_identity ON questions;
CREATE TRIGGER validate_question_identity
  BEFORE INSERT OR UPDATE ON questions
  FOR EACH ROW
  EXECUTE FUNCTION validate_question_identity_access();

-- ============================================================================
-- FACILITATOR RULES (Dynamic, adjusted by coaching)
-- ============================================================================
CREATE TABLE IF NOT EXISTS facilitator_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  max_questions_per_window INTEGER DEFAULT 2,
  question_window_hours INTEGER DEFAULT 48,
  minimum_wait_after_question INTEGER DEFAULT 24,       -- hours
  maximum_silence_before_prompt INTEGER DEFAULT 72,     -- hours
  minimum_wait_after_human_message INTEGER DEFAULT 30,  -- minutes

  phase VARCHAR(20) DEFAULT 'early'
    CHECK (phase IN ('early', 'established', 'mature')),

  current_signal VARCHAR(20) DEFAULT 'neutral'
    CHECK (current_signal IN ('hold_back', 'neutral', 'jump_in')),
  signal_reason TEXT,

  updated_by VARCHAR(50) DEFAULT 'system'
    CHECK (updated_by IN ('system', 'coach', 'admin')),
  previous_rules JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  is_active BOOLEAN DEFAULT TRUE
);

COMMENT ON TABLE facilitator_rules IS 'Adaptive engagement rules for Facilitator.';

-- ensure only one active ruleset per family
CREATE UNIQUE INDEX IF NOT EXISTS uq_facilitator_rules_one_active
  ON facilitator_rules(family_id)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_facilitator_rules_updated_at ON facilitator_rules;
CREATE TRIGGER update_facilitator_rules_updated_at
BEFORE UPDATE ON facilitator_rules
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- REAL-TIME LEVERS (Immediate flow control)
-- ============================================================================
CREATE TABLE IF NOT EXISTS real_time_levers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  active_conversation_cooldown INTEGER DEFAULT 30,      -- minutes
  storytelling_cooldown INTEGER DEFAULT 15,             -- minutes
  grace_period_before_asking INTEGER DEFAULT 3,         -- minutes

  sensitive_topic_cooldown INTEGER DEFAULT 24,          -- hours
  emotional_keywords TEXT[] DEFAULT ARRAY[]::TEXT[],
  celebration_delay INTEGER DEFAULT 12,                 -- hours after sensitive content

  require_answer_before_next BOOLEAN DEFAULT FALSE,
  max_repeats_before_retiring INTEGER DEFAULT 2,
  repeat_rephrase_delay INTEGER DEFAULT 7,              -- days

  context_check_message_count INTEGER DEFAULT 10,
  skip_if_answered_recently BOOLEAN DEFAULT TRUE,

  enable_fatigue_detection BOOLEAN DEFAULT TRUE,
  fatigue_threshold DECIMAL DEFAULT 0.3,
  fatigue_backoff_percent DECIMAL DEFAULT 0.5,

  updated_by VARCHAR(50) DEFAULT 'system'
    CHECK (updated_by IN ('system', 'coach', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  is_active BOOLEAN DEFAULT TRUE
);

COMMENT ON TABLE real_time_levers IS 'Immediate conversation flow controls (dynamic knobs).';

-- ensure only one active leverset per family
CREATE UNIQUE INDEX IF NOT EXISTS uq_real_time_levers_one_active
  ON real_time_levers(family_id)
  WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_family_config_one_active
  ON family_config(family_id)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_real_time_levers_updated_at ON real_time_levers;
CREATE TRIGGER update_real_time_levers_updated_at
BEFORE UPDATE ON real_time_levers
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- FACILITATOR PERFORMANCE (Coaching metrics)
-- ============================================================================
-- For POC: store aggregates per day or per evaluation window.
CREATE TABLE IF NOT EXISTS facilitator_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,

  questions_asked INTEGER DEFAULT 0,
  questions_answered INTEGER DEFAULT 0,
  questions_ignored INTEGER DEFAULT 0,
  conversations_interrupted INTEGER DEFAULT 0,

  response_rate DECIMAL,                         -- optional derived
  notes TEXT,

  computed_by VARCHAR(50) DEFAULT 'system'
    CHECK (computed_by IN ('system', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE facilitator_performance IS 'Coaching metrics for Facilitator behavior tuning.';

CREATE INDEX IF NOT EXISTS idx_fac_perf_family_window
  ON facilitator_performance(family_id, window_start DESC);

-- ============================================================================
-- EVENT LOG (Complete audit trail)
-- ============================================================================
CREATE TABLE IF NOT EXISTS event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  event_type VARCHAR(50) NOT NULL,                -- 'event_ingested','question_asked','conflict_detected','facilitator_decision', etc.
  event_category VARCHAR(50) NOT NULL
    CHECK (event_category IN ('user_action', 'bot_action', 'system_event', 'coaching')),

  actor VARCHAR(255),
  actor_type VARCHAR(50)
    CHECK (actor_type IS NULL OR actor_type IN ('user', 'bot', 'system')),

  event_data JSONB,

  conversation_event_id UUID,

  session_id UUID,
  identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,
  severity VARCHAR(20) DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'error')),

  CONSTRAINT uq_event_log_family_id UNIQUE (family_id, id),
  CONSTRAINT fk_event_log_conversation_event
    FOREIGN KEY (family_id, conversation_event_id)
    REFERENCES conversation_events(family_id, id)
    ON DELETE SET NULL
);

COMMENT ON TABLE event_log IS 'Append-only audit trail. RLS enabled: no direct client access; read via backend/admin only.';

CREATE INDEX IF NOT EXISTS idx_event_log_family_time
  ON event_log(family_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_family_type
  ON event_log(family_id, event_type);

CREATE INDEX IF NOT EXISTS idx_event_log_family_actor
  ON event_log(family_id, actor);

-- ============================================================================
-- CONVERSATION EVENT PROCESSING (Preprocessing artifacts)
-- ============================================================================
-- Stores preprocessing results (pronoun resolution, language detection, etc.)
-- Separate from conversation_events to keep original events fully immutable
CREATE TABLE IF NOT EXISTS conversation_event_processing (
  conversation_event_id UUID PRIMARY KEY,
  family_id UUID NOT NULL,

  -- Preprocessing results
  content_processed TEXT,                      -- Content after pronoun resolution
  detected_language VARCHAR(10),               -- Language detected by preprocessing (if different from original)
  image_references JSONB,                      -- Image references extracted from message

  -- Processing metadata
  processing_metadata JSONB,                   -- Agent versions, token usage, etc.
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  processed_by VARCHAR(50),                    -- Agent name: 'intern', 'scribe', etc.

  -- Composite FK enforces tenant integrity
  CONSTRAINT fk_event_processing_event
    FOREIGN KEY (family_id, conversation_event_id)
    REFERENCES conversation_events(family_id, id)
    ON DELETE CASCADE
);

COMMENT ON TABLE conversation_event_processing IS
  'Preprocessing artifacts for conversation events. Mutable - can be reprocessed. Original events remain immutable in conversation_events.';
COMMENT ON COLUMN conversation_event_processing.content_processed IS
  'Content after pronoun resolution. This is what the Scribe agent processes for extraction.';
COMMENT ON COLUMN conversation_event_processing.detected_language IS
  'Language detected during preprocessing. May differ from language_original if preprocessing improves detection.';
COMMENT ON COLUMN conversation_event_processing.image_references IS
  'Array of image references extracted by preprocessing: [{imageId, referenceType, peopleIdentified, contextProvided}]';
COMMENT ON COLUMN conversation_event_processing.processing_metadata IS
  'Agent metadata: versions, model used, token usage, processing duration, etc.';

CREATE INDEX IF NOT EXISTS idx_event_processing_family
  ON conversation_event_processing(family_id);

CREATE INDEX IF NOT EXISTS idx_event_processing_processed_at
  ON conversation_event_processing(family_id, processed_at DESC);

-- ============================================================================
-- CONVERSATION REDACTIONS (Non-destructive privacy controls)
-- ============================================================================
-- Tracks redaction separately to keep conversation_events immutable
CREATE TABLE IF NOT EXISTS conversation_redactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  conversation_event_id UUID NOT NULL,

  -- Redaction metadata
  redacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redacted_by_identity_id UUID REFERENCES identities(id),
  redaction_reason TEXT NOT NULL,

  -- Audit trail link
  event_log_id UUID,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, conversation_event_id),

  -- Composite FKs enforce tenant integrity
  CONSTRAINT fk_conversation_redactions_event
    FOREIGN KEY (family_id, conversation_event_id)
    REFERENCES conversation_events(family_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_conversation_redactions_event_log
    FOREIGN KEY (family_id, event_log_id)
    REFERENCES event_log(family_id, id)
    ON DELETE SET NULL
);

COMMENT ON TABLE conversation_redactions IS
  'Non-destructive redaction log. conversation_events remains immutable.';

CREATE INDEX IF NOT EXISTS idx_conv_redactions_family_event
  ON conversation_redactions(family_id, conversation_event_id);

CREATE INDEX IF NOT EXISTS idx_conv_redactions_redacted_at
  ON conversation_redactions(family_id, redacted_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_redactions_redacted_by
  ON conversation_redactions(family_id, redacted_by_identity_id)
  WHERE redacted_by_identity_id IS NOT NULL;

-- ============================================================================
-- ALLOWED CHATS (Global allowlist - checked before any processing)
-- ============================================================================
CREATE TABLE IF NOT EXISTS allowed_chats (
  source VARCHAR(50) NOT NULL,                  -- 'telegram', 'whatsapp', 'discord', etc.
  chat_id TEXT NOT NULL,                        -- Provider chat ID (e.g., Telegram chat_id as string)
  note TEXT,                                    -- e.g., "Garcia family group", "Test chat"
  created_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (source, chat_id),

  CONSTRAINT valid_allowed_chat_source CHECK (
    source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  )
);

COMMENT ON TABLE allowed_chats IS 'Global allowlist of (source, chat_id) pairs allowed to use the bot. Checked before any processing.';

-- ============================================================================
-- ACCESS PASSES (One-Time Tokens for Chat → Studio)
-- ============================================================================
CREATE TABLE IF NOT EXISTS access_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Token stored as hash for security (original token sent to user, only hash stored)
  token_hash TEXT NOT NULL UNIQUE,

  -- What access this pass grants
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),

  -- Who requested this pass (chat provider identity - for lookup only, no profile data)
  provider VARCHAR(50) NOT NULL,                -- 'telegram', 'whatsapp', 'discord', etc.
  provider_user_id VARCHAR(255) NOT NULL,

  -- Optional link to existing identity
  identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,

  -- Chat context (which chat the pass was requested from)
  chat_id TEXT NOT NULL,

  -- Expiration and usage
  expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  redeemed_at TIMESTAMPTZ,
  redeemed_by_identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT valid_access_pass_provider CHECK (
    provider IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  )
);

COMMENT ON TABLE access_passes IS 'One-time tokens generated via chat commands (e.g., /sobremesa studio-link) for chat → Studio access.';
COMMENT ON COLUMN access_passes.token_hash IS 'SHA-256 hash of the access token (original token sent via DM)';
COMMENT ON COLUMN access_passes.role IS 'Role granted when pass is redeemed (based on chat admin status)';
COMMENT ON COLUMN access_passes.provider IS 'Chat provider: telegram, discord, slack, etc.';

CREATE INDEX IF NOT EXISTS idx_access_passes_token_hash
  ON access_passes(token_hash);

CREATE INDEX IF NOT EXISTS idx_access_passes_provider_user
  ON access_passes(provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_access_passes_family
  ON access_passes(family_id);

CREATE INDEX IF NOT EXISTS idx_access_passes_pending
  ON access_passes(status, expires_at)
  WHERE status = 'pending';

-- ============================================================================
-- TELEGRAM CHAT ADMINS (Cached Admin Status)
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL,                  -- 'telegram', 'whatsapp', 'discord', etc.
  chat_id TEXT NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,       -- Provider-specific user ID (e.g., Telegram user_id as string)

  -- Admin status from provider API
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  admin_title VARCHAR(255),                     -- Custom admin title if set (provider-specific)

  -- Provider-specific permissions (stored as JSONB for flexibility)
  -- For Telegram: {"can_manage_chat": true, "can_delete_messages": true, ...}
  -- For Discord: {"administrator": true, "manage_channels": true, ...}
  permissions JSONB DEFAULT '{}'::jsonb,

  -- Sync tracking
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, source, chat_id, provider_user_id),

  CONSTRAINT valid_chat_admin_source CHECK (
    source IN ('telegram', 'whatsapp', 'discord', 'slack', 'sms', 'email')
  )
);

COMMENT ON TABLE chat_admins IS 'Cached chat admin status from provider APIs for role determination. Provider-neutral with JSONB permissions.';
COMMENT ON COLUMN chat_admins.is_admin IS 'Whether user is admin/creator of the chat';
COMMENT ON COLUMN chat_admins.permissions IS 'Provider-specific permissions as JSONB. Telegram: {can_manage_chat, can_delete_messages}. Discord: {administrator, manage_channels}.';

CREATE INDEX IF NOT EXISTS idx_chat_admins_family_chat
  ON chat_admins(family_id, source, chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_admins_provider_user
  ON chat_admins(source, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_chat_admins_family_user
  ON chat_admins(family_id, source, provider_user_id);

DROP TRIGGER IF EXISTS update_chat_admins_updated_at ON chat_admins;
CREATE TRIGGER update_chat_admins_updated_at
BEFORE UPDATE ON chat_admins
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- INTEGRITY CHECKPOINTS (Hash anchoring ready)
-- ============================================================================
CREATE TABLE IF NOT EXISTS integrity_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  checkpoint_type VARCHAR(50) NOT NULL DEFAULT 'event_log', -- 'event_log','conversation_events'
  range_start TIMESTAMPTZ,
  range_end TIMESTAMPTZ,

  -- Store a checkpoint hash/root (recommended: HMAC/Merkle root computed off-db)
  checkpoint_hash TEXT NOT NULL,

  -- Optional chain anchoring metadata
  chain VARCHAR(50),                              -- 'solana','ethereum','polygon', etc.
  tx_hash TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE integrity_checkpoints IS 'Tamper-evident checkpoints; can be anchored on-chain without exposing content.';

CREATE INDEX IF NOT EXISTS idx_integrity_checkpoints_family_time
  ON integrity_checkpoints(family_id, created_at DESC);

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================
-- Important: All views use security_invoker=true to respect RLS policies
-- instead of using SECURITY DEFINER which bypasses RLS

-- REMOVED: active_conversation_events view
-- This view cannot work with security_invoker=true when conversation_events has no client SELECT policy.
-- conversation_events is service-role only (no RLS SELECT policy) for security.
-- If you need client access to sanitized events, implement via:
--   A) Backend API endpoint that queries conversation_events and filters/transforms, or
--   B) Separate materialized table populated by backend with appropriate RLS policies
-- DO NOT recreate this view without changing conversation_events RLS model.

-- CREATE OR REPLACE VIEW active_conversation_events
-- WITH (security_invoker=true) AS
-- SELECT ce.*
-- FROM conversation_events ce
-- LEFT JOIN conversation_redactions cr
--   ON cr.family_id = ce.family_id
--   AND cr.conversation_event_id = ce.id
-- WHERE cr.id IS NULL;

CREATE OR REPLACE VIEW pending_questions
WITH (security_invoker=true) AS
SELECT *
FROM questions
WHERE status = 'proposed';

COMMENT ON VIEW pending_questions IS 'Questions awaiting action (proposed but not yet asked). Order at query time.';

CREATE OR REPLACE VIEW active_claims
WITH (security_invoker=true) AS
SELECT *
FROM claims
WHERE status = 'active';

COMMENT ON VIEW active_claims IS 'Non-redacted active claims (canonical provenance layer). Order at query time.';

CREATE OR REPLACE VIEW conflicting_claims
WITH (security_invoker=true) AS
SELECT
  c.family_id,
  c.id AS claim_id,
  c.subject,
  c.claim_type,
  c.claim_value,
  c.claimed_by,
  c.confidence,
  array_agg(cc.conflicts_with_claim_id) AS conflicts_with
FROM claims c
JOIN claim_conflicts cc
  ON cc.family_id = c.family_id
 AND cc.claim_id = c.id
WHERE c.status <> 'redacted'
GROUP BY c.family_id, c.id, c.subject, c.claim_type, c.claim_value, c.claimed_by, c.confidence;

COMMENT ON VIEW conflicting_claims IS 'Claims with conflicts (preserved, not resolved).';

-- ============================================================================
-- DEFAULT SEED DATA (POC convenience)
-- Creates a default family + active rules/levers if none exist.
-- Safe to run repeatedly.
-- ============================================================================
DO $$
DECLARE
  default_family_id UUID;
BEGIN
  -- Create default family if none exists
  SELECT id INTO default_family_id
  FROM families
  WHERE is_active = TRUE
  ORDER BY created_at ASC
  LIMIT 1;

  IF default_family_id IS NULL THEN
    INSERT INTO families (name, config)
    VALUES ('Default Family', '{}'::jsonb)
    RETURNING id INTO default_family_id;
  END IF;

  -- Initialize sequence counter for default family
  INSERT INTO sequence_counters (scope_type, scope_id, counter_name, next_sequence)
  VALUES ('family', default_family_id, 'events', 1)
  ON CONFLICT (scope_type, scope_id, counter_name) DO NOTHING;

  -- Facilitator rules: ensure one active ruleset for default family
  IF NOT EXISTS (
    SELECT 1 FROM facilitator_rules
    WHERE family_id = default_family_id AND is_active = TRUE
  ) THEN
    INSERT INTO facilitator_rules (
      family_id,
      max_questions_per_window,
      question_window_hours,
      minimum_wait_after_question,
      maximum_silence_before_prompt,
      minimum_wait_after_human_message,
      phase,
      current_signal,
      is_active
    ) VALUES (
      default_family_id,
      2,      -- conservative start
      48,     -- 48-hour window
      48,     -- wait 48 hours after each question
      168,    -- prompt after 7 days silence
      30,     -- 30 min after human message
      'early',
      'neutral',
      TRUE
    );
  END IF;

  -- Real-time levers: ensure one active leverset for default family
  IF NOT EXISTS (
    SELECT 1 FROM real_time_levers
    WHERE family_id = default_family_id AND is_active = TRUE
  ) THEN
    INSERT INTO real_time_levers (
      family_id,
      active_conversation_cooldown,
      storytelling_cooldown,
      grace_period_before_asking,
      sensitive_topic_cooldown,
      emotional_keywords,
      celebration_delay,
      require_answer_before_next,
      max_repeats_before_retiring,
      repeat_rephrase_delay,
      context_check_message_count,
      skip_if_answered_recently,
      enable_fatigue_detection,
      fatigue_threshold,
      fatigue_backoff_percent,
      is_active
    ) VALUES (
      default_family_id,
      30,
      15,
      3,
      24,
      ARRAY[
        'died','death','war','lost','terrible','awful','grief',
        'murió','muerte','guerra','perdió','dolor'
      ],
      12,
      FALSE,
      2,
      7,
      10,
      TRUE,
      TRUE,
      0.3,
      0.5,
      TRUE
    );
  END IF;
END $$;
-- ============================================================================
-- IMMUTABILITY ENFORCEMENT
-- ============================================================================

-- Prevent ALL updates to conversation_events
CREATE OR REPLACE FUNCTION prevent_conversation_event_updates()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events is immutable - updates are not allowed'
    USING HINT = 'Use conversation_event_processing for preprocessing artifacts, processing_queue for state management, conversation_redactions for privacy';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_conversation_event_updates IS 'Enforce full immutability of conversation_events table';

DROP TRIGGER IF EXISTS enforce_conversation_events_immutable ON conversation_events;
CREATE TRIGGER enforce_conversation_events_immutable
  BEFORE UPDATE ON conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_conversation_event_updates();

-- Prevent DELETEs (use redactions instead)
CREATE OR REPLACE FUNCTION prevent_conversation_event_deletes()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events is immutable - deletes are not allowed'
    USING HINT = 'Use conversation_redactions for privacy controls';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_conversation_event_deletes IS 'Enforce immutability of conversation_events table';

DROP TRIGGER IF EXISTS enforce_conversation_events_no_delete ON conversation_events;
CREATE TRIGGER enforce_conversation_events_no_delete
  BEFORE DELETE ON conversation_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_conversation_event_deletes();

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Enable RLS on new tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_admins ENABLE ROW LEVEL SECURITY;

-- Enable RLS on existing tables that need it
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_event_processing ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_redactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilitator_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE real_time_levers ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilitator_performance ENABLE ROW LEVEL SECURITY;
-- allowed_chats is backend-only (service_role access), no RLS needed
-- ALTER TABLE allowed_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;

-- Phase 1 tables
ALTER TABLE sequence_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_batches ENABLE ROW LEVEL SECURITY;

-- Phase 1c tables
ALTER TABLE entity_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_evaluation_queue ENABLE ROW LEVEL SECURITY;

-- Phase 2 join tables
ALTER TABLE story_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_places ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- USERS policies
-- --------------------------------------------------------------------------
-- Users can read their own record (via identity)
CREATE POLICY "users_select_own" ON users
  FOR SELECT USING (
    id IN (SELECT user_id FROM identities WHERE id = get_identity_id())
  );

-- Super admins can read all users
CREATE POLICY "users_select_super_admin" ON users
  FOR SELECT USING (is_super_admin());

-- Users can update their own profile (role changes prevented by trigger)
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (
    id IN (SELECT user_id FROM identities WHERE id = get_identity_id())
  )
  WITH CHECK (
    id IN (SELECT user_id FROM identities WHERE id = get_identity_id())
  );

-- --------------------------------------------------------------------------
-- IDENTITIES policies
-- --------------------------------------------------------------------------
-- Users can read their own record
CREATE POLICY "identities_select_own" ON identities
  FOR SELECT USING (id = get_identity_id());

-- Super admins can read all identities
CREATE POLICY "identities_select_super_admin" ON identities
  FOR SELECT USING (is_super_admin());

-- Users can update their own identity profile
CREATE POLICY "identities_update_own" ON identities
  FOR UPDATE USING (id = get_identity_id())
  WITH CHECK (id = get_identity_id());

-- --------------------------------------------------------------------------
-- FAMILY_ACCESS policies
-- --------------------------------------------------------------------------
-- Users can see access records for families they belong to
CREATE POLICY "family_access_select" ON family_access
  FOR SELECT USING (
    family_id IN (SELECT * FROM get_user_family_ids())
  );

-- Family admins can manage access for their family
CREATE POLICY "family_access_insert" ON family_access
  FOR INSERT WITH CHECK (
    is_family_admin(family_id)
  );

CREATE POLICY "family_access_update" ON family_access
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

CREATE POLICY "family_access_delete" ON family_access
  FOR DELETE USING (
    is_family_admin(family_id)
    OR identity_id = get_identity_id() -- Users can revoke their own access
  );

-- --------------------------------------------------------------------------
-- ACCESS_PASSES policies (admin only via service role for security)
-- --------------------------------------------------------------------------
-- Family admins can see passes for their family
CREATE POLICY "access_passes_select" ON access_passes
  FOR SELECT USING (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- TELEGRAM_CHAT_ADMINS policies
-- --------------------------------------------------------------------------
-- Family members can see chat admins for their family
CREATE POLICY "chat_admins_select" ON chat_admins
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FAMILIES policies
-- --------------------------------------------------------------------------
-- Users can see families they belong to
CREATE POLICY "families_select" ON families
  FOR SELECT USING (id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- PEOPLE policies
-- --------------------------------------------------------------------------
-- Family members can view people
CREATE POLICY "people_select" ON people
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Family admins can insert/update people
CREATE POLICY "people_insert" ON people
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "people_update" ON people
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- PLACES policies
-- --------------------------------------------------------------------------
CREATE POLICY "places_select" ON places
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "places_insert" ON places
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "places_update" ON places
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- EVENTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "events_select" ON events
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "events_insert" ON events
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "events_update" ON events
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- STORIES policies
-- --------------------------------------------------------------------------
CREATE POLICY "stories_select" ON stories
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "stories_insert" ON stories
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "stories_update" ON stories
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- RELATIONSHIPS policies
-- --------------------------------------------------------------------------
CREATE POLICY "relationships_select" ON relationships
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "relationships_insert" ON relationships
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "relationships_update" ON relationships
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CLAIMS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claims_select" ON claims
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- QUESTIONS policies
-- --------------------------------------------------------------------------
CREATE POLICY "questions_select" ON questions
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- IMAGES policies
-- --------------------------------------------------------------------------
CREATE POLICY "images_select" ON images
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FAMILY_CONFIG policies
-- --------------------------------------------------------------------------
CREATE POLICY "family_config_select" ON family_config
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "family_config_insert" ON family_config
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "family_config_update" ON family_config
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- PROCESSING_QUEUE policies
-- --------------------------------------------------------------------------
-- Backend service role manages queue (users can only view their family's queue)
CREATE POLICY "processing_queue_select" ON processing_queue
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- CLAIM_CONFLICTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claim_conflicts_select" ON claim_conflicts
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FACILITATOR_RULES policies
-- --------------------------------------------------------------------------
CREATE POLICY "facilitator_rules_select" ON facilitator_rules
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "facilitator_rules_insert" ON facilitator_rules
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "facilitator_rules_update" ON facilitator_rules
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- REAL_TIME_LEVERS policies
-- --------------------------------------------------------------------------
CREATE POLICY "real_time_levers_select" ON real_time_levers
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "real_time_levers_insert" ON real_time_levers
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "real_time_levers_update" ON real_time_levers
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- FACILITATOR_PERFORMANCE policies
-- --------------------------------------------------------------------------
CREATE POLICY "facilitator_performance_select" ON facilitator_performance
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "facilitator_performance_insert" ON facilitator_performance
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "facilitator_performance_update" ON facilitator_performance
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- ALLOWED_CHATS policies
-- --------------------------------------------------------------------------
-- Backend-only table (service_role access), RLS disabled
-- Ingestion service needs to read this before processing events
-- Managed via backend API or SQL migrations only
-- (RLS policies removed - table has no RLS enabled)

-- --------------------------------------------------------------------------
-- INTEGRITY_CHECKPOINTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "integrity_checkpoints_select" ON integrity_checkpoints
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "integrity_checkpoints_insert" ON integrity_checkpoints
  FOR INSERT WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CONVERSATION_EVENTS policies
-- --------------------------------------------------------------------------
-- Note: No SELECT policy = service-role only access (as documented)
-- Raw ingestion ledger includes sensitive data (source_payload, metadata, actor details)
-- Client access should be via backend API that queries and filters/transforms as needed
-- Note: INSERT/UPDATE/DELETE also service-role only (no policy = blocked by RLS)

-- --------------------------------------------------------------------------
-- CONVERSATION_REDACTIONS policies
-- --------------------------------------------------------------------------
CREATE POLICY "conversation_redactions_select" ON conversation_redactions
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "conversation_redactions_insert" ON conversation_redactions
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "conversation_redactions_delete" ON conversation_redactions
  FOR DELETE USING (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CONVERSATION_EVENT_PROCESSING policies
-- --------------------------------------------------------------------------
-- Backend-only access (service_role) for insert/update/delete
-- Read access for family members (for debugging/transparency)
CREATE POLICY "conversation_event_processing_select" ON conversation_event_processing
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE/DELETE on conversation_event_processing is service-role only (no policy = blocked by RLS)

-- --------------------------------------------------------------------------
-- EVENT_LOG policies
-- --------------------------------------------------------------------------
CREATE POLICY "event_log_select" ON event_log
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: event_log INSERT is service-role only (no policy = blocked by RLS)

-- --------------------------------------------------------------------------
-- CONVERSATION_EVENTS policies (additional)
-- --------------------------------------------------------------------------
-- Note: conversation_events INSERT is service-role only (no policy = blocked by RLS)
-- SELECT policy already exists above

-- --------------------------------------------------------------------------
-- SEQUENCE_COUNTERS policies
-- --------------------------------------------------------------------------
-- Service-role only - no client access needed
-- (no policies = blocked by RLS for all client operations)

-- --------------------------------------------------------------------------
-- INGESTION_BATCHES policies
-- --------------------------------------------------------------------------
CREATE POLICY "ingestion_batches_select" ON ingestion_batches
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE is service-role only

-- --------------------------------------------------------------------------
-- ENTITY_MERGES policies
-- --------------------------------------------------------------------------
CREATE POLICY "entity_merges_select" ON entity_merges
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "entity_merges_insert" ON entity_merges
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "entity_merges_delete" ON entity_merges
  FOR DELETE USING (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CLAIM_ENTITIES policies
-- --------------------------------------------------------------------------
CREATE POLICY "claim_entities_select" ON claim_entities
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE via service-role only (managed by Registrar)

-- --------------------------------------------------------------------------
-- CLAIM_RELATIONSHIPS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claim_relationships_select" ON claim_relationships
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE via service-role only (managed by Registrar)

-- --------------------------------------------------------------------------
-- CLAIM_ANALYSIS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claim_analysis_select" ON claim_analysis
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE via service-role only (system-computed metadata)

-- --------------------------------------------------------------------------
-- LLM_EVALUATION_QUEUE policies
-- --------------------------------------------------------------------------
CREATE POLICY "llm_evaluation_queue_select" ON llm_evaluation_queue
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE via service-role only (managed by LLM workers)

-- --------------------------------------------------------------------------
-- JOIN TABLE policies (story_people, story_places, story_events, event_people, event_places)
-- --------------------------------------------------------------------------
CREATE POLICY "story_people_select" ON story_people
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "story_places_select" ON story_places
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "story_events_select" ON story_events
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "story_conversation_events_select" ON story_conversation_events
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "event_people_select" ON event_people
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

CREATE POLICY "event_places_select" ON event_places
  FOR SELECT USING (family_id IN (SELECT * FROM get_user_family_ids()));

-- Note: INSERT/UPDATE/DELETE for join tables via service-role only (managed by Registrar/Historian)

-- ============================================================================
-- PARTICIPANT VERIFICATION FUNCTIONS
-- ============================================================================

-- Check if a person's linked identity has sent messages in a conversation
CREATE OR REPLACE FUNCTION is_person_participant(
  p_family_id UUID,
  p_conversation_id TEXT,
  p_person_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM conversation_events ce
    JOIN identities i ON i.provider = ce.source
      AND i.provider_user_id = ce.actor_external_id
    JOIN family_access fa ON fa.identity_id = i.id
      AND fa.family_id = ce.family_id
    WHERE ce.family_id = p_family_id
      AND ce.conversation_id = p_conversation_id
      AND fa.person_id = p_person_id
      AND fa.status = 'active'
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION is_person_participant IS
  'Check if a person is a verified conversation participant (their identity has sent messages).';

-- Get all verified participants in a conversation
CREATE OR REPLACE FUNCTION get_conversation_participants(
  p_family_id UUID,
  p_conversation_id TEXT
) RETURNS TABLE (
  person_id UUID,
  person_name TEXT,
  identity_id UUID,
  identity_display_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT
    p.id AS person_id,
    p.name AS person_name,
    i.id AS identity_id,
    i.display_name AS identity_display_name
  FROM conversation_events ce
  JOIN identities i ON i.provider = ce.source
    AND i.provider_user_id = ce.actor_external_id
  JOIN family_access fa ON fa.identity_id = i.id
    AND fa.family_id = ce.family_id
  JOIN people p ON p.id = fa.person_id
    AND p.family_id = fa.family_id
  WHERE ce.family_id = p_family_id
    AND ce.conversation_id = p_conversation_id
    AND fa.status = 'active'
    AND fa.person_id IS NOT NULL
    AND p.redacted = false
  ORDER BY p.name;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_conversation_participants IS
  'Get all verified participants (people whose identities have sent messages).';

-- Get participants with their family relationships (for question targeting context)
CREATE OR REPLACE FUNCTION get_participants_with_relationships(
  p_family_id UUID,
  p_conversation_id TEXT
) RETURNS TABLE (
  person_id UUID,
  person_name TEXT,
  relationship_type TEXT,
  related_person_id UUID,
  related_person_name TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH participants AS (
    SELECT DISTINCT p.id AS participant_id, p.name AS participant_name
    FROM conversation_events ce
    JOIN identities i ON i.provider = ce.source
      AND i.provider_user_id = ce.actor_external_id
    JOIN family_access fa ON fa.identity_id = i.id
      AND fa.family_id = ce.family_id
    JOIN people p ON p.id = fa.person_id
      AND p.family_id = fa.family_id
    WHERE ce.family_id = p_family_id
      AND ce.conversation_id = p_conversation_id
      AND fa.status = 'active'
      AND fa.person_id IS NOT NULL
      AND p.redacted = false
  )
  SELECT
    pt.participant_id AS person_id,
    pt.participant_name AS person_name,
    -- Relationship type from participant's perspective
    CASE
      WHEN r.person_a_id = pt.participant_id THEN
        CASE r.relationship_type WHEN 'parent' THEN 'parent' ELSE r.relationship_type END
      WHEN r.person_b_id = pt.participant_id THEN
        CASE r.relationship_type WHEN 'parent' THEN 'child' ELSE r.relationship_type END
      ELSE NULL
    END AS relationship_type,
    CASE
      WHEN r.person_a_id = pt.participant_id THEN r.person_b_id
      WHEN r.person_b_id = pt.participant_id THEN r.person_a_id
      ELSE NULL
    END AS related_person_id,
    rp.name AS related_person_name
  FROM participants pt
  LEFT JOIN relationships r ON r.family_id = p_family_id
    AND (r.person_a_id = pt.participant_id OR r.person_b_id = pt.participant_id)
    AND r.status = 'active'
  LEFT JOIN people rp ON rp.family_id = p_family_id
    AND rp.id = CASE
      WHEN r.person_a_id = pt.participant_id THEN r.person_b_id
      WHEN r.person_b_id = pt.participant_id THEN r.person_a_id
    END
    AND rp.redacted = false
  ORDER BY pt.participant_name, rp.name;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_participants_with_relationships IS
  'Get participants with family relationships (one row per relationship, includes participants without relationships).';

-- Find participants connected to a specific subject (person/event/place/story)
CREATE OR REPLACE FUNCTION get_participants_related_to_subject(
  p_family_id UUID,
  p_conversation_id TEXT,
  p_subject_type TEXT,  -- 'person', 'event', 'place', 'story'
  p_subject_id UUID
) RETURNS TABLE (
  person_id UUID,
  person_name TEXT,
  connection_reason TEXT,
  connection_type TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH verified_participants AS (
    SELECT DISTINCT p.id AS participant_id, p.name AS participant_name
    FROM conversation_events ce
    JOIN identities i ON i.provider = ce.source
      AND i.provider_user_id = ce.actor_external_id
    JOIN family_access fa ON fa.identity_id = i.id
      AND fa.family_id = ce.family_id
    JOIN people p ON p.id = fa.person_id
      AND p.family_id = fa.family_id
    WHERE ce.family_id = p_family_id
      AND ce.conversation_id = p_conversation_id
      AND fa.status = 'active'
      AND fa.person_id IS NOT NULL
      AND p.redacted = false
  )
  SELECT * FROM (
    -- Subject is PERSON: find participants with relationships
    SELECT
      vp.participant_id AS person_id,
      vp.participant_name AS person_name,
      CASE
        WHEN r.person_a_id = vp.participant_id THEN
          CASE r.relationship_type
            WHEN 'parent' THEN 'parent of ' ELSE r.relationship_type || ' of '
          END || subject_person.name
        ELSE
          CASE r.relationship_type
            WHEN 'parent' THEN 'child of ' ELSE r.relationship_type || ' of '
          END || subject_person.name
      END AS connection_reason,
      'relationship'::TEXT AS connection_type
    FROM verified_participants vp
    JOIN relationships r ON r.family_id = p_family_id
      AND (r.person_a_id = vp.participant_id OR r.person_b_id = vp.participant_id)
      AND (r.person_a_id = p_subject_id OR r.person_b_id = p_subject_id)
      AND r.person_a_id != r.person_b_id
      AND r.status = 'active'
    JOIN people subject_person ON subject_person.id = p_subject_id
      AND subject_person.family_id = p_family_id
    WHERE p_subject_type = 'person'
      AND vp.participant_id != p_subject_id

    UNION ALL

    -- Subject is PERSON: include if participant IS the subject (direct match)
    SELECT vp.participant_id, vp.participant_name,
      'is this person'::TEXT, 'direct'::TEXT
    FROM verified_participants vp
    WHERE p_subject_type = 'person' AND vp.participant_id = p_subject_id

    UNION ALL

    -- Subject is EVENT: find participants involved
    SELECT vp.participant_id, vp.participant_name,
      'involved in event: ' || e.title, 'event_participant'::TEXT
    FROM verified_participants vp
    JOIN event_people ep ON ep.family_id = p_family_id
      AND ep.person_id = vp.participant_id AND ep.event_id = p_subject_id
    JOIN events e ON e.id = p_subject_id AND e.family_id = p_family_id
    WHERE p_subject_type = 'event'

    UNION ALL

    -- Subject is PLACE: find participants via events at that place
    SELECT DISTINCT vp.participant_id, vp.participant_name,
      'connected via event: ' || e.title, 'event_participant'::TEXT
    FROM verified_participants vp
    JOIN event_people ep ON ep.family_id = p_family_id
      AND ep.person_id = vp.participant_id
    JOIN event_places epl ON epl.family_id = p_family_id
      AND epl.event_id = ep.event_id AND epl.place_id = p_subject_id
    JOIN events e ON e.id = ep.event_id AND e.family_id = p_family_id
    WHERE p_subject_type = 'place'

    UNION ALL

    -- Subject is STORY: find participants mentioned
    SELECT vp.participant_id, vp.participant_name,
      'mentioned in story: ' || s.title, 'story_mention'::TEXT
    FROM verified_participants vp
    JOIN story_people sp ON sp.family_id = p_family_id
      AND sp.person_id = vp.participant_id AND sp.story_id = p_subject_id
    JOIN stories s ON s.id = p_subject_id AND s.family_id = p_family_id
    WHERE p_subject_type = 'story'
  ) combined
  ORDER BY person_name;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_participants_related_to_subject IS
  'Find participants connected to a subject (person/event/place/story) for focused question targeting.';

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
