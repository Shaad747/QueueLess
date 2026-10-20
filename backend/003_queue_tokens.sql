BEGIN;

CREATE TABLE daily_sequences (
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_date DATE NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (service_id, service_date)
);

CREATE TABLE queue_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  visitor_id INTEGER NOT NULL REFERENCES users(id),
  service_date DATE NOT NULL,
  token_number INTEGER NOT NULL CHECK (token_number > 0),
  status TEXT NOT NULL DEFAULT 'WAITING'
    CHECK (
      status IN (
        'WAITING',
        'CALLED',
        'SERVING',
        'COMPLETED',
        'CANCELLED',
        'NO_SHOW'
      )
    ),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (service_id, service_date, token_number)
);

CREATE UNIQUE INDEX one_active_token_per_visitor_service_day
  ON queue_tokens (visitor_id, service_id, service_date)
  WHERE status IN ('WAITING', 'CALLED', 'SERVING');

COMMIT;