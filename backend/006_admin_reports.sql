BEGIN;
SELECT pg_advisory_xact_lock(74129, 2);
ALTER TABLE services ADD COLUMN IF NOT EXISTS business_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_event_type_check;
ALTER TABLE queue_events ADD CONSTRAINT queue_events_event_type_check
  CHECK (event_type IN ('JOINED','CANCELLED','CALLED','SERVING','COMPLETED','NO_SHOW'));
CREATE TABLE IF NOT EXISTS admin_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS auth_limits (
  bucket TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(bucket, bucket_start)
);
CREATE INDEX IF NOT EXISTS auth_limits_expiry_idx ON auth_limits(bucket_start);
CREATE INDEX IF NOT EXISTS tokens_service_date_status_issued ON queue_tokens(service_id, service_date, status, issued_at);
CREATE INDEX IF NOT EXISTS visits_recent_completed ON service_visits(completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE OR REPLACE VIEW daily_service_report AS
SELECT t.service_date, t.service_id,
 count(*)::integer AS tokens,
 count(*) FILTER (WHERE t.status = 'WAITING')::integer AS waiting,
 count(*) FILTER (WHERE t.status IN ('CALLED','SERVING'))::integer AS in_progress,
 count(*) FILTER (WHERE t.status = 'COMPLETED')::integer AS completed,
 count(*) FILTER (WHERE t.status = 'CANCELLED')::integer AS cancelled,
 count(*) FILTER (WHERE t.status = 'NO_SHOW')::integer AS no_shows,
 avg(EXTRACT(EPOCH FROM (v.called_at - t.issued_at)) / 60.0) AS average_wait_minutes,
 percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (v.called_at - t.issued_at)) / 60.0)
   FILTER (WHERE v.called_at IS NOT NULL) AS median_wait_minutes,
 avg(EXTRACT(EPOCH FROM (v.completed_at - v.started_at)) / 60.0)
   FILTER (WHERE v.completed_at IS NOT NULL) AS mean_service_minutes
FROM queue_tokens t LEFT JOIN service_visits v ON v.token_id = t.id
GROUP BY t.service_date, t.service_id;
COMMIT;
