SELECT
  id,
  family_id,
  source,
  conversation_id,
  external_event_id,
  actor_display_name,
  actor_username,
  content_original,
  occurred_at
FROM conversation_events
ORDER BY occurred_at DESC;