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
-- PostgreSQL 14+
-- Requires: pgcrypto (for gen_random_uuid)
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
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FAMILIES (Family Spaces / Tenants)
-- ============================================================================
CREATE TABLE IF NOT EXISTS families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,

  -- Optional config directly on the family for POC convenience
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE families IS 'Top-level family spaces (e.g. maternal side, paternal side)';

DROP TRIGGER IF EXISTS update_families_updated_at ON families;
CREATE TRIGGER update_families_updated_at
BEFORE UPDATE ON families
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- FAMILY CONFIG (Optional separate table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS family_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
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
-- CONVERSATION EVENTS (Raw Ingestion Ledger)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

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
  language_original VARCHAR(10),                -- 'es','en','mixed', etc.

  -- Provider-specific metadata
  metadata JSONB,

  -- Raw provider payload (optional; useful for debugging/replay)
  source_payload JSONB,

  -- Processing state
  processed BOOLEAN DEFAULT FALSE,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,

  -- Privacy / redaction
  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  -- Integrity primitive (recommended: HMAC, not raw hash)
  content_hmac TEXT,

  -- Timestamps
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, source, conversation_id, external_event_id)
);

COMMENT ON TABLE conversation_events IS 'Ingestion ledger. RLS enabled: no direct client access; read via backend/admin only.';
COMMENT ON COLUMN conversation_events.metadata IS 'Provider-specific metadata (e.g., Telegram: message_id, chat_id, edit_date; WhatsApp: status_id, timestamp_ms).';

CREATE INDEX IF NOT EXISTS idx_conv_events_family_time
  ON conversation_events(family_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_events_unprocessed
  ON conversation_events(family_id, processed)
  WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_conv_events_family_conversation
  ON conversation_events(family_id, source, conversation_id);

-- ============================================================================
-- PROCESSING QUEUE (Ordered processing support)
-- ============================================================================
-- Use this if you're DB-polling workers (instead of Redis/BullMQ).
-- Maintains ordered, retryable processing.
CREATE TABLE IF NOT EXISTS processing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  conversation_event_id UUID NOT NULL REFERENCES conversation_events(id),

  -- Ordering: primarily by occurred_at, tie-break by ingested_at/id
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(255),

  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','done','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  UNIQUE(family_id, conversation_event_id)
);

COMMENT ON TABLE processing_queue IS 'Ordered processing queue for Scribe pipeline.';

CREATE INDEX IF NOT EXISTS idx_processing_queue_ready
  ON processing_queue(family_id, status, queued_at)
  WHERE status IN ('queued','error');

-- ============================================================================
-- PEOPLE (Identity + optional derived summaries)
-- ============================================================================
CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Primary identity
  name VARCHAR(255) NOT NULL,
  aliases JSONB DEFAULT '[]',

  -- OPTIONAL derived summaries (canonical provenance lives in claims)
  birth_year INTEGER,
  birth_year_confidence VARCHAR(20),           -- 'high','medium','low'
  death_year INTEGER,
  death_year_confidence VARCHAR(20),

  -- Notes (original language only; translate on-read)
  notes_original TEXT,
  language_original VARCHAR(10),

  -- Source tracking
  first_mentioned_event_id UUID REFERENCES conversation_events(id),
  created_by VARCHAR(255),

  -- Privacy
  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  -- Integrity (optional per-record HMAC for derived content)
  content_hmac TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE people IS 'People mentioned in family history (identity + optional derived summaries).';
COMMENT ON COLUMN people.birth_year IS 'Derived summary; canonical provenance lives in claims.';
COMMENT ON COLUMN people.death_year IS 'Derived summary; canonical provenance lives in claims.';

CREATE INDEX IF NOT EXISTS idx_people_family_name
  ON people(family_id, name);

CREATE INDEX IF NOT EXISTS idx_people_not_redacted
  ON people(family_id, redacted)
  WHERE redacted = FALSE;

DROP TRIGGER IF EXISTS update_people_updated_at ON people;
CREATE TRIGGER update_people_updated_at
BEFORE UPDATE ON people
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- IDENTITIES (Provider accounts mapped to internal UUIDs)
-- ============================================================================
CREATE TABLE IF NOT EXISTS identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  -- Provider identity
  source VARCHAR(50) NOT NULL,                 -- 'telegram', 'whatsapp', etc.
  provider_user_id VARCHAR(255) NOT NULL,      -- e.g. Telegram from.id (string)

  -- Latest known profile snapshot (optional; may change on provider)
  display_name VARCHAR(255),
  username VARCHAR(255),

  -- Optional link to a canonical "person" (real-world entity)
  person_id UUID NULL REFERENCES people(id),

  is_active BOOLEAN DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (family_id, source, provider_user_id)
);

COMMENT ON TABLE identities IS
'Provider-level user accounts (e.g., Telegram user id) mapped to internal UUIDs; optionally linked to canonical people.';

CREATE INDEX IF NOT EXISTS idx_identities_family_source_user
  ON identities(family_id, source, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_identities_family_person
  ON identities(family_id, person_id)
  WHERE person_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_identities_updated_at ON identities;
CREATE TRIGGER update_identities_updated_at
BEFORE UPDATE ON identities
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- RELATIONSHIPS (Explicit edges)
-- ============================================================================
CREATE TABLE IF NOT EXISTS relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  person_a_id UUID NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  person_b_id UUID NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  relationship_type VARCHAR(50) NOT NULL,      -- 'parent','child','spouse','sibling'

  confidence VARCHAR(20) DEFAULT 'medium',

  source_event_id UUID REFERENCES conversation_events(id),
  claimed_by VARCHAR(255),

  description_original TEXT,
  language_original VARCHAR(10),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT no_self_relationship CHECK (person_a_id != person_b_id)
);

COMMENT ON TABLE relationships IS 'Claimed relationships between people (edges).';

CREATE INDEX IF NOT EXISTS idx_relationships_family
  ON relationships(family_id);

CREATE INDEX IF NOT EXISTS idx_relationships_person_a
  ON relationships(family_id, person_a_id);

CREATE INDEX IF NOT EXISTS idx_relationships_person_b
  ON relationships(family_id, person_b_id);

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

  first_mentioned_event_id UUID REFERENCES conversation_events(id),

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE places IS 'Geographic locations mentioned in stories.';

CREATE INDEX IF NOT EXISTS idx_places_family_name
  ON places(family_id, name);

CREATE INDEX IF NOT EXISTS idx_places_family_country
  ON places(family_id, country);

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
  date_year INTEGER,
  date_month INTEGER,
  date_day INTEGER,
  date_approximate VARCHAR(255),               -- "late 1880s", "summer"
  date_confidence VARCHAR(20),

  -- Connections (POC-friendly arrays; can be normalized later)
  people_involved UUID[],
  place_id UUID REFERENCES places(id),

  -- Source
  source_event_id UUID REFERENCES conversation_events(id),
  claimed_by VARCHAR(255),

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE events IS 'Timeline events derived from claims (with optional summary fields).';

CREATE INDEX IF NOT EXISTS idx_events_family_year
  ON events(family_id, date_year);

CREATE INDEX IF NOT EXISTS idx_events_family_type
  ON events(family_id, event_type);

DROP TRIGGER IF EXISTS update_events_updated_at ON events;
CREATE TRIGGER update_events_updated_at
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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

  -- Connections (POC-friendly arrays)
  people UUID[],
  places UUID[],
  events UUID[],

  -- Provenance (stories may span multiple raw events)
  source_event_ids UUID[],
  shared_by VARCHAR(255),

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE stories IS 'Coherent narrative fragments derived from conversations.';

CREATE INDEX IF NOT EXISTS idx_stories_family_timeframe
  ON stories(family_id, timeframe);

CREATE INDEX IF NOT EXISTS idx_stories_not_redacted
  ON stories(family_id, redacted)
  WHERE redacted = FALSE;

DROP TRIGGER IF EXISTS update_stories_updated_at ON stories;
CREATE TRIGGER update_stories_updated_at
BEFORE UPDATE ON stories
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- CLAIMS (Atomic provenance layer)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),

  claim_type VARCHAR(50) NOT NULL,             -- 'date','location','relationship','fact'
  subject VARCHAR(255) NOT NULL,               -- searchable human label
  claim_value JSONB NOT NULL,                  -- flexible payload

  -- Provenance
  source_event_id UUID NOT NULL REFERENCES conversation_events(id),
  claimed_by VARCHAR(255) NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),

  -- Certainty
  confidence VARCHAR(20) DEFAULT 'medium',
  certainty_language TEXT,                     -- "definitely","I think","probably"

  -- Context (original language only; translate on-read)
  context_original TEXT,
  language_original VARCHAR(10),

  -- Entity association (polymorphic)
  entity_id UUID,
  entity_type VARCHAR(50),                     -- 'person','place','event','story'

  status VARCHAR(20) DEFAULT 'active',         -- 'active','superseded','disputed','redacted'

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  content_hmac TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE claims IS 'Atomic factual claims with full provenance (canonical truth layer).';

DROP TRIGGER IF EXISTS update_claims_updated_at ON claims;
CREATE TRIGGER update_claims_updated_at
BEFORE UPDATE ON claims
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_claims_family_type
  ON claims(family_id, claim_type);

CREATE INDEX IF NOT EXISTS idx_claims_family_subject
  ON claims(family_id, subject);

CREATE INDEX IF NOT EXISTS idx_claims_family_entity
  ON claims(family_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_claims_family_source
  ON claims(family_id, source_event_id);

CREATE INDEX IF NOT EXISTS idx_claims_active
  ON claims(family_id, status)
  WHERE status = 'active';

-- ============================================================================
-- CLAIM CONFLICTS (Explicit preservation, graph-friendly)
-- ============================================================================
CREATE TABLE IF NOT EXISTS claim_conflicts (
  family_id UUID NOT NULL REFERENCES families(id),
  claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  conflicts_with_claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (family_id, claim_id, conflicts_with_claim_id),
  CONSTRAINT no_self_conflict CHECK (claim_id != conflicts_with_claim_id)
);

COMMENT ON TABLE claim_conflicts IS 'Explicit links between conflicting claims (never resolved). Cascades delete when either claim is removed.';

CREATE INDEX IF NOT EXISTS idx_claim_conflicts_family_claim
  ON claim_conflicts(family_id, claim_id);

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

  -- Connections (POC-friendly arrays)
  connected_stories UUID[],
  connected_people UUID[],

  -- Provenance
  source_event_id UUID NOT NULL REFERENCES conversation_events(id),
  shared_by VARCHAR(255),

  analyzed BOOLEAN DEFAULT FALSE,
  analyzed_at TIMESTAMPTZ,

  redacted BOOLEAN DEFAULT FALSE,
  redacted_at TIMESTAMPTZ,
  redacted_by VARCHAR(255),
  redaction_reason TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, source, external_file_id)
);

COMMENT ON TABLE images IS 'Photos and documents shared in conversations.';

CREATE INDEX IF NOT EXISTS idx_images_family_analyzed
  ON images(family_id, analyzed)
  WHERE analyzed = FALSE;

CREATE INDEX IF NOT EXISTS idx_images_family_source_event
  ON images(family_id, source_event_id);

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
  origin TEXT NOT NULL CHECK (origin IN ('scribe', 'curator', 'human')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'asked', 'answered', 'retired')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority >= 0 AND priority <= 100),

  -- Source tracking
  source_message_id UUID NULL REFERENCES conversation_events(id),
  asked_by_identity_id UUID NULL REFERENCES identities(id),

  -- When asked/answered
  asked_at TIMESTAMPTZ NULL,
  answered_at TIMESTAMPTZ NULL,
  answer_message_id UUID NULL REFERENCES conversation_events(id),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE questions IS 'Question lifecycle managed by Facilitator.';

CREATE INDEX IF NOT EXISTS idx_questions_family_status
  ON questions(family_id, status);

CREATE INDEX IF NOT EXISTS idx_questions_family_priority
  ON questions(family_id, status, priority DESC)
  WHERE status = 'proposed';

DROP TRIGGER IF EXISTS update_questions_updated_at ON questions;
CREATE TRIGGER update_questions_updated_at
BEFORE UPDATE ON questions
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

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

  phase VARCHAR(20) DEFAULT 'early',                    -- 'early','established','mature'

  current_signal VARCHAR(20) DEFAULT 'neutral',         -- 'hold_back','neutral','jump_in'
  signal_reason TEXT,

  updated_by VARCHAR(50) DEFAULT 'system',              -- 'system','coach','admin'
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

  updated_by VARCHAR(50) DEFAULT 'system',
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

  computed_by VARCHAR(50) DEFAULT 'system',       -- 'system','admin'
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
  event_category VARCHAR(50) NOT NULL,            -- 'user_action','bot_action','system_event','coaching'

  actor VARCHAR(255),
  actor_type VARCHAR(50),                         -- 'user','bot','system'

  event_data JSONB,

  source_event_id UUID REFERENCES conversation_events(id),

  session_id UUID,
  identity_id UUID,
  severity VARCHAR(20) DEFAULT 'info'             -- 'info','warning','error'
);

COMMENT ON TABLE event_log IS 'Append-only audit trail. RLS enabled: no direct client access; read via backend/admin only.';

CREATE INDEX IF NOT EXISTS idx_event_log_family_time
  ON event_log(family_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_family_type
  ON event_log(family_id, event_type);

CREATE INDEX IF NOT EXISTS idx_event_log_family_actor
  ON event_log(family_id, actor);  

-- ============================================================================
-- Enable RLS so client roles cannot write without explicit policies.
--
-- SECURITY NOTE (Supabase):
-- Writes to event_log and conversation_events must come only from backend code using the service_role key.
-- Client roles (anon/authenticated) should not have insert/update/delete access to these tables.
--
-- RLS POLICIES (Backend Responsibility):
-- After enabling RLS, backend MUST create policies:
--   1. family_isolation_select: Allow reading only user's family_id
--   2. family_isolation_insert: Allow writing only to user's family_id (for authenticated users)
--   3. service_role_bypass: Service role bypasses RLS for backend operations
-- 
-- Example (adjust based on auth structure):
-- CREATE POLICY "family_isolation_select" ON conversation_events
--   FOR SELECT USING (family_id IN (SELECT family_id FROM user_families WHERE user_id = auth.uid()));
-- ============================================================================
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;

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
CREATE OR REPLACE VIEW active_conversation_events AS
SELECT *
FROM conversation_events
WHERE redacted = FALSE
ORDER BY occurred_at DESC;

COMMENT ON VIEW active_conversation_events IS 'Non-redacted conversation events (raw input).';

CREATE OR REPLACE VIEW pending_questions AS
SELECT *
FROM questions
WHERE status = 'proposed'
ORDER BY priority DESC, created_at ASC;

COMMENT ON VIEW pending_questions IS 'Questions awaiting action (proposed but not yet asked).';

CREATE OR REPLACE VIEW active_claims AS
SELECT *
FROM claims
WHERE redacted = FALSE
  AND status = 'active'
ORDER BY claimed_at DESC;

COMMENT ON VIEW active_claims IS 'Non-redacted active claims (canonical provenance layer).';

CREATE OR REPLACE VIEW conflicting_claims AS
SELECT
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
WHERE c.redacted = FALSE
GROUP BY c.id, c.subject, c.claim_type, c.claim_value, c.claimed_by, c.confidence;

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
-- END OF SCHEMA
-- ============================================================================