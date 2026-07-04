-- Deterministic claim attribution (provenance-integrity-plan.md #2).
--
-- claimed_by is stamped by the pipeline from the source conversation event's
-- sender, never from LLM extraction. This migration adds a resolved identity
-- FK for that deterministic sender, and a separate free-text field for
-- secondhand attribution the speaker themselves asserts (e.g. "Mom always
-- said..."). Existing claimed_by values are historical/LLM-derived; no
-- backfill of claimed_by_identity_id is performed (see plan's open decisions).

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS claimed_by_identity_id UUID REFERENCES identities(id),
  ADD COLUMN IF NOT EXISTS attributed_to VARCHAR(255);

COMMENT ON COLUMN claims.claimed_by_identity_id IS 'Identity of the deterministic sender of the source event, resolved by provider + provider_user_id. NULL for historical rows and for sources (e.g. WhatsApp import) that do not create identities.';
COMMENT ON COLUMN claims.attributed_to IS 'Person the speaker attributes this claim to, set only when claimed_by_source is attributed or hearsay (e.g. "Mom always said..." -> attributed_to: Mom). Free text, not entity-resolved.';

CREATE INDEX IF NOT EXISTS idx_claims_claimed_by_identity
  ON claims(claimed_by_identity_id)
  WHERE claimed_by_identity_id IS NOT NULL;

-- enforce_claims_immutability() (init migration) predates these columns and
-- does not protect them; without this they could be silently mutated post-
-- insert, defeating the point of pipeline-stamped provenance.
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
     OLD.claimed_by_identity_id IS DISTINCT FROM NEW.claimed_by_identity_id OR
     OLD.claimed_by_source IS DISTINCT FROM NEW.claimed_by_source OR
     OLD.attributed_to IS DISTINCT FROM NEW.attributed_to OR
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
