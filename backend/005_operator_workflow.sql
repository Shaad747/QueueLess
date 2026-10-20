BEGIN;

CREATE TABLE IF NOT EXISTS service_visits (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id INTEGER NOT NULL UNIQUE REFERENCES queue_tokens(id),
  counter_id INTEGER NOT NULL REFERENCES counters(id),
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  CHECK (started_at IS NULL OR started_at >= called_at),
  CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
  CHECK (ended_at IS NULL OR ended_at >= called_at),
  CHECK (completed_at IS NULL OR ended_at = completed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_visit_per_counter
  ON service_visits(counter_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS waiting_tokens_fifo
  ON queue_tokens(service_id, service_date, token_number) WHERE status = 'WAITING';

CREATE TABLE IF NOT EXISTS queue_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_id INTEGER NOT NULL REFERENCES queue_tokens(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('CALLED', 'SERVING', 'COMPLETED', 'NO_SHOW')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS queue_events_token_idx ON queue_events(token_id, id);

-- A retried request returns its original result, without acting on another visitor.
CREATE TABLE IF NOT EXISTS operator_requests (
  actor_id INTEGER NOT NULL REFERENCES users(id),
  request_id UUID NOT NULL,
  counter_id INTEGER NOT NULL REFERENCES counters(id),
  action TEXT NOT NULL CHECK (action IN ('call-next', 'start', 'complete', 'no-show')),
  token_id INTEGER,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (actor_id, request_id)
);

COMMIT;
