-- Enforce one in-flight queue item per family at dequeue time.
--
-- The application may run multiple queue workers, but family-local context
-- resolution depends on processing events sequentially within a family. This
-- function leases a single ready row while locking the corresponding families
-- row during candidate selection, so two concurrent dequeue transactions cannot
-- lease different rows for the same family.

CREATE INDEX IF NOT EXISTS idx_processing_queue_inflight_family
  ON public.processing_queue(family_id, locked_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.dequeue_processing_queue_item(
  p_worker_id TEXT,
  p_lock_timeout_ms INTEGER DEFAULT 300000,
  p_family_id UUID DEFAULT NULL
)
RETURNS SETOF public.processing_queue
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_lock_expiry TIMESTAMPTZ := NOW() - make_interval(
    secs => GREATEST(COALESCE(p_lock_timeout_ms, 300000), 0)::DOUBLE PRECISION / 1000.0
  );
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT q.id
    FROM public.processing_queue q
    JOIN public.families f ON f.id = q.family_id
    WHERE q.status = 'queued'
      AND q.process_after <= NOW()
      AND (p_family_id IS NULL OR q.family_id = p_family_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.processing_queue inflight
        WHERE inflight.family_id = q.family_id
          AND inflight.status = 'processing'
      )
    ORDER BY q.priority ASC, q.queued_at ASC
    LIMIT 1
    FOR UPDATE OF q, f SKIP LOCKED
  )
  UPDATE public.processing_queue q
  SET status = 'processing',
      locked_at = NOW(),
      locked_by = p_worker_id
  FROM candidate
  WHERE q.id = candidate.id
    AND q.status = 'queued'
  RETURNING q.*;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT q.id
    FROM public.processing_queue q
    JOIN public.families f ON f.id = q.family_id
    WHERE q.status = 'processing'
      AND q.locked_at < v_lock_expiry
      AND q.process_after <= NOW()
      AND (p_family_id IS NULL OR q.family_id = p_family_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.processing_queue inflight
        WHERE inflight.family_id = q.family_id
          AND inflight.status = 'processing'
          AND inflight.id <> q.id
          AND (
            inflight.locked_at IS NULL
            OR inflight.locked_at >= v_lock_expiry
          )
      )
    ORDER BY q.priority ASC, q.queued_at ASC
    LIMIT 1
    FOR UPDATE OF q, f SKIP LOCKED
  )
  UPDATE public.processing_queue q
  SET locked_at = NOW(),
      locked_by = p_worker_id
  FROM candidate
  WHERE q.id = candidate.id
    AND q.status = 'processing'
  RETURNING q.*;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.dequeue_processing_queue_item(TEXT, INTEGER, UUID)
  IS 'Leases one ready processing_queue row while enforcing one in-flight item per family. Queued rows are skipped for families that already have status=processing; stale processing locks are retried only after no queued candidate is available.';
