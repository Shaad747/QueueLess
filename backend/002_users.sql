BEGIN;

CREATE TABLE users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT NOT NULL CHECK (length(trim(email)) > 0),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'visitor'
    CHECK (role IN ('visitor', 'operator', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_unique
  ON users (LOWER(TRIM(email)));

COMMIT;