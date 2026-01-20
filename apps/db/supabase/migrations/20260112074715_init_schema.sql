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
$$ LANGUAGE plpgsql
SET search_path = '';  -- Prevent search path manipulation attacks

-- ============================================================================
-- FAMILIES (Family Spaces / Tenants)
-- ============================================================================
CREATE TABLE IF NOT EXISTS families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,

  -- Optional config directly on the family for POC convenience
  config JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Chat ID for linking to a chat provider (provider-agnostic)
  chat_id TEXT UNIQUE,

  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE families IS 'Top-level family spaces (e.g. maternal side, paternal side)';

DROP TRIGGER IF EXISTS update_families_updated_at ON families;
CREATE TRIGGER update_families_updated_at
BEFORE UPDATE ON families
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_families_chat_id ON families(chat_id);

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

  -- Integrity primitive (recommended: HMAC, not raw hash)
  content_hmac TEXT,

  -- Timestamps
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, source, conversation_id, external_event_id),
  CONSTRAINT uq_conversation_events_family_id UNIQUE (family_id, id)
);

COMMENT ON TABLE conversation_events IS 'Immutable ingestion ledger. State in processing_queue, redaction in conversation_redactions. RLS enabled: no direct client access; read via backend/admin only.';
COMMENT ON COLUMN conversation_events.metadata IS 'Provider-specific metadata (e.g., Telegram: message_id, chat_id, edit_date; WhatsApp: status_id, timestamp_ms).';

CREATE INDEX IF NOT EXISTS idx_conv_events_family_time
  ON conversation_events(family_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_conv_events_family_conversation
  ON conversation_events(family_id, source, conversation_id);

-- ============================================================================
-- PROCESSING QUEUE (Ordered processing support)
-- ============================================================================
-- Use this if you're DB-polling workers (instead of Redis/BullMQ).
-- Maintains ordered, retryable processing with priority support.
CREATE TABLE IF NOT EXISTS processing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  conversation_event_id UUID NOT NULL REFERENCES conversation_events(id),

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

  UNIQUE(family_id, conversation_event_id)
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
  aliases JSONB DEFAULT '[]',

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
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_people_family_id UNIQUE (family_id, id)
);

COMMENT ON TABLE people IS 'People mentioned in family history (identity + optional derived summaries).';
COMMENT ON COLUMN people.birth_year IS 'Derived summary; canonical provenance lives in claims.';
COMMENT ON COLUMN people.death_year IS 'Derived summary; canonical provenance lives in claims.';
COMMENT ON COLUMN people.is_placeholder IS 'True if this person is a placeholder for an unknown individual in the family tree.';

CREATE INDEX IF NOT EXISTS idx_people_family_name
  ON people(family_id, name);

CREATE INDEX IF NOT EXISTS idx_people_not_redacted
  ON people(family_id, redacted)
  WHERE redacted = FALSE;

CREATE INDEX IF NOT EXISTS idx_people_placeholder
  ON people(family_id, is_placeholder)
  WHERE is_placeholder = TRUE;

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
  UNIQUE (provider, provider_user_id)
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
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,

  -- How this access was granted
  granted_by VARCHAR(50) NOT NULL DEFAULT 'system',
    -- 'chat_join' | 'studio_link' | 'admin' | 'system' | 'telegram_login' | 'access_pass'
  granted_at TIMESTAMPTZ DEFAULT NOW(),

  -- Revocation tracking
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES identities(id),
  revoke_reason TEXT,

  -- Optional notes (e.g., "Original group admin", "Invited by Maria")
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(identity_id, family_id)
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

  person_a_id UUID NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  person_b_id UUID NOT NULL REFERENCES people(id) ON DELETE RESTRICT,

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

  source_event_id UUID REFERENCES conversation_events(id),
  claimed_by VARCHAR(255),

  description_original TEXT,
  language_original VARCHAR(10),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT no_self_relationship CHECK (person_a_id != person_b_id)
);

COMMENT ON TABLE relationships IS 'Relationships between people. Parent+spouse form the family tree backbone; others are narrative relationships.';
COMMENT ON COLUMN relationships.relationship_type IS 'Type: parent, spouse, guardian, godparent, mentor, friend, etc.';
COMMENT ON COLUMN relationships.category IS 'Category: biological, legal, functional, honorary, social';
COMMENT ON COLUMN relationships.status IS 'Status: active, ended, deceased';
COMMENT ON COLUMN relationships.qualifier IS 'Qualifier: half, step, adoptive, maternal, paternal, etc.';

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
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_places_family_id UNIQUE (family_id, id)
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
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT fk_events_place_family
    FOREIGN KEY (family_id, place_id)
    REFERENCES places(family_id, id)
    ON DELETE SET NULL
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
  claimed_by_source VARCHAR(20),              -- 'direct','attributed','hearsay'
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

CREATE INDEX IF NOT EXISTS idx_claims_family_source_type
  ON claims(family_id, claimed_by_source)
  WHERE claimed_by_source IS NOT NULL;

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

  -- External message tracking (for answer detection)
  asked_external_message_id TEXT NULL,

  -- Targeting metadata (for Facilitator warmth formatting)
  target_person TEXT NULL,
  target_event TEXT NULL,
  target_place TEXT NULL,
  story_context TEXT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
-- CONVERSATION REDACTIONS (Non-destructive privacy controls)
-- ============================================================================
-- Tracks redaction separately to keep conversation_events immutable
CREATE TABLE IF NOT EXISTS conversation_redactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id),
  conversation_event_id UUID NOT NULL
    REFERENCES conversation_events(id) ON DELETE RESTRICT,

  -- Redaction metadata
  redacted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redacted_by_identity_id UUID REFERENCES identities(id),
  redaction_reason TEXT NOT NULL,

  -- Audit trail link
  event_log_id UUID REFERENCES event_log(id),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, conversation_event_id)
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
  chat_id TEXT PRIMARY KEY,                     -- Provider chat ID (e.g., Telegram chat_id as string)
  source VARCHAR(50) NOT NULL DEFAULT 'telegram', -- 'telegram', 'whatsapp', etc.
  note TEXT,                                    -- e.g., "Garcia family group", "Test chat"
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE allowed_chats IS 'Global allowlist of chat IDs allowed to use the bot. Checked before any processing.';

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
  provider VARCHAR(50) NOT NULL DEFAULT 'telegram',
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

  created_at TIMESTAMPTZ DEFAULT NOW()
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
CREATE TABLE IF NOT EXISTS telegram_chat_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  telegram_user_id BIGINT NOT NULL,

  -- Admin status from Telegram API
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  admin_title VARCHAR(255), -- Custom admin title if set
  can_manage_chat BOOLEAN DEFAULT FALSE,
  can_delete_messages BOOLEAN DEFAULT FALSE,

  -- Sync tracking
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(family_id, chat_id, telegram_user_id)
);

COMMENT ON TABLE telegram_chat_admins IS 'Cached Telegram chat admin status for role determination.';
COMMENT ON COLUMN telegram_chat_admins.is_admin IS 'Whether user is admin/creator of the chat';

CREATE INDEX IF NOT EXISTS idx_telegram_chat_admins_family_chat
  ON telegram_chat_admins(family_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_admins_telegram_user
  ON telegram_chat_admins(telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_admins_family_user
  ON telegram_chat_admins(family_id, telegram_user_id);

DROP TRIGGER IF EXISTS update_telegram_chat_admins_updated_at ON telegram_chat_admins;
CREATE TRIGGER update_telegram_chat_admins_updated_at
BEFORE UPDATE ON telegram_chat_admins
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

CREATE OR REPLACE VIEW active_conversation_events
WITH (security_invoker=true) AS
SELECT ce.*
FROM conversation_events ce
LEFT JOIN conversation_redactions cr
  ON cr.family_id = ce.family_id
  AND cr.conversation_event_id = ce.id
WHERE cr.id IS NULL
ORDER BY ce.occurred_at DESC;

COMMENT ON VIEW active_conversation_events IS 'Non-redacted conversation events (immutable raw input).';

CREATE OR REPLACE VIEW pending_questions 
WITH (security_invoker=true) AS
SELECT *
FROM questions
WHERE status = 'proposed'
ORDER BY priority DESC, created_at ASC;

COMMENT ON VIEW pending_questions IS 'Questions awaiting action (proposed but not yet asked).';

CREATE OR REPLACE VIEW active_claims 
WITH (security_invoker=true) AS
SELECT *
FROM claims
WHERE redacted = FALSE
  AND status = 'active'
ORDER BY claimed_at DESC;

COMMENT ON VIEW active_claims IS 'Non-redacted active claims (canonical provenance layer).';

CREATE OR REPLACE VIEW conflicting_claims 
WITH (security_invoker=true) AS
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
-- RLS HELPER FUNCTIONS
-- ============================================================================

-- Get current user's identity_id from JWT claim
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

-- Check if user is member (or higher) of a specific family
CREATE OR REPLACE FUNCTION is_family_member(target_family_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN public.get_family_role(target_family_id) IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = '';

COMMENT ON FUNCTION is_family_member IS 'Check if user has any access to a specific family';

-- ============================================================================
-- IMMUTABILITY ENFORCEMENT
-- ============================================================================

-- Prevent ALL updates to conversation_events
CREATE OR REPLACE FUNCTION prevent_conversation_event_updates()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'conversation_events is immutable - updates are not allowed'
    USING HINT = 'Use processing_queue for state management, conversation_redactions for privacy';
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_conversation_event_updates IS 'Enforce immutability of conversation_events table';

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
END;
$$ LANGUAGE plpgsql
SET search_path = '';

COMMENT ON FUNCTION prevent_conversation_event_deletes IS 'Enforce immutability of conversation_events table';

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
ALTER TABLE telegram_chat_admins ENABLE ROW LEVEL SECURITY;

-- Enable RLS on existing tables that need it
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE allowed_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;

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

-- Users can update their own profile (but not role)
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (
    id IN (SELECT user_id FROM identities WHERE id = get_identity_id())
  )
  WITH CHECK (
    id IN (SELECT user_id FROM identities WHERE id = get_identity_id())
    AND role = (SELECT role FROM users WHERE id IN (SELECT user_id FROM identities WHERE id = get_identity_id()))
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
    family_id IN (SELECT get_user_family_ids())
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
CREATE POLICY "telegram_chat_admins_select" ON telegram_chat_admins
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FAMILIES policies
-- --------------------------------------------------------------------------
-- Users can see families they belong to
CREATE POLICY "families_select" ON families
  FOR SELECT USING (id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- PEOPLE policies
-- --------------------------------------------------------------------------
-- Family members can view people
CREATE POLICY "people_select" ON people
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

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
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "places_insert" ON places
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "places_update" ON places
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- EVENTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "events_select" ON events
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "events_insert" ON events
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "events_update" ON events
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- STORIES policies
-- --------------------------------------------------------------------------
CREATE POLICY "stories_select" ON stories
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "stories_insert" ON stories
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "stories_update" ON stories
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- RELATIONSHIPS policies
-- --------------------------------------------------------------------------
CREATE POLICY "relationships_select" ON relationships
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "relationships_insert" ON relationships
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "relationships_update" ON relationships
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CLAIMS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claims_select" ON claims
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- QUESTIONS policies
-- --------------------------------------------------------------------------
CREATE POLICY "questions_select" ON questions
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- IMAGES policies
-- --------------------------------------------------------------------------
CREATE POLICY "images_select" ON images
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FAMILY_CONFIG policies
-- --------------------------------------------------------------------------
CREATE POLICY "family_config_select" ON family_config
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

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
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- CLAIM_CONFLICTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "claim_conflicts_select" ON claim_conflicts
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- FACILITATOR_RULES policies
-- --------------------------------------------------------------------------
CREATE POLICY "facilitator_rules_select" ON facilitator_rules
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "facilitator_rules_insert" ON facilitator_rules
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "facilitator_rules_update" ON facilitator_rules
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- REAL_TIME_LEVERS policies
-- --------------------------------------------------------------------------
CREATE POLICY "real_time_levers_select" ON real_time_levers
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "real_time_levers_insert" ON real_time_levers
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "real_time_levers_update" ON real_time_levers
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- FACILITATOR_PERFORMANCE policies
-- --------------------------------------------------------------------------
CREATE POLICY "facilitator_performance_select" ON facilitator_performance
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "facilitator_performance_insert" ON facilitator_performance
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "facilitator_performance_update" ON facilitator_performance
  FOR UPDATE USING (is_family_admin(family_id))
  WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- ALLOWED_CHATS policies
-- --------------------------------------------------------------------------
-- Global table (no family_id) - only super admins can manage
CREATE POLICY "allowed_chats_select" ON allowed_chats
  FOR SELECT USING (is_super_admin());

CREATE POLICY "allowed_chats_insert" ON allowed_chats
  FOR INSERT WITH CHECK (is_super_admin());

CREATE POLICY "allowed_chats_update" ON allowed_chats
  FOR UPDATE USING (is_super_admin())
  WITH CHECK (is_super_admin());

CREATE POLICY "allowed_chats_delete" ON allowed_chats
  FOR DELETE USING (is_super_admin());

-- --------------------------------------------------------------------------
-- INTEGRITY_CHECKPOINTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "integrity_checkpoints_select" ON integrity_checkpoints
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "integrity_checkpoints_insert" ON integrity_checkpoints
  FOR INSERT WITH CHECK (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- CONVERSATION_EVENTS policies
-- --------------------------------------------------------------------------
CREATE POLICY "conversation_events_select" ON conversation_events
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- --------------------------------------------------------------------------
-- CONVERSATION_REDACTIONS policies
-- --------------------------------------------------------------------------
CREATE POLICY "conversation_redactions_select" ON conversation_redactions
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

CREATE POLICY "conversation_redactions_insert" ON conversation_redactions
  FOR INSERT WITH CHECK (is_family_admin(family_id));

CREATE POLICY "conversation_redactions_delete" ON conversation_redactions
  FOR DELETE USING (is_family_admin(family_id));

-- --------------------------------------------------------------------------
-- EVENT_LOG policies
-- --------------------------------------------------------------------------
CREATE POLICY "event_log_select" ON event_log
  FOR SELECT USING (family_id IN (SELECT get_user_family_ids()));

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
