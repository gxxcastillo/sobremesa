-- Rename source_event_id to conversation_event_id in claims table
-- This provides clearer semantics about what type of event is referenced

-- Drop dependent objects first
DROP INDEX IF EXISTS idx_claims_family_source;
DROP TRIGGER IF EXISTS enforce_claims_immutability_trigger ON claims;

-- Rename the column
ALTER TABLE claims
  RENAME COLUMN source_event_id TO conversation_event_id;

-- Recreate the index with new column name
CREATE INDEX IF NOT EXISTS idx_claims_family_conversation_event
  ON claims(family_id, conversation_event_id);

-- Update the trigger function to use new column name
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
     OLD.language_original IS DISTINCT FROM NEW.language_original
  THEN
    RAISE EXCEPTION 'Immutable claim fields cannot be modified (claim_type, subject, claim_value, conversation_event_id, claimed_by, claimed_by_source, claimed_at, certainty_language, context_original, language_original)';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- Recreate the trigger
CREATE TRIGGER enforce_claims_immutability_trigger
  BEFORE UPDATE ON claims
  FOR EACH ROW
  EXECUTE FUNCTION enforce_claims_immutability();

-- Update the table comment to reflect the change
COMMENT ON COLUMN claims.conversation_event_id IS 'Reference to the conversation event where this claim originated';
