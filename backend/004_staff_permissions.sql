BEGIN;

CREATE TABLE IF NOT EXISTS counters (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (service_id, name)
);

CREATE TABLE IF NOT EXISTS counter_assignments (
  counter_id INTEGER NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
  operator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (counter_id, operator_id)
);
CREATE INDEX IF NOT EXISTS counter_assignments_operator_idx
  ON counter_assignments(operator_id);

-- One initial counter for each existing service. Re-running adds no duplicates.
INSERT INTO counters (service_id, name)
SELECT id, 'Counter 1' FROM services
ON CONFLICT (service_id, name) DO NOTHING;

COMMIT;
