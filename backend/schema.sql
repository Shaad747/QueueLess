CREATE TABLE IF NOT EXISTS services (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  opening_hours TEXT NOT NULL,
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  people_waiting INTEGER NOT NULL DEFAULT 0 CHECK (people_waiting >= 0),
  estimated_wait_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (estimated_wait_minutes >= 0)
);

INSERT INTO services
  (name, description, opening_hours, is_open, people_waiting, estimated_wait_minutes)
VALUES
  (
    'Student Services Desk',
    'Enrollment letters, forms, and student records.',
    '9:00 AM – 4:00 PM',
    TRUE,
    8,
    20
  ),
  (
    'Print & Copy Centre',
    'Printing, photocopying, and document binding.',
    '8:30 AM – 5:00 PM',
    TRUE,
    3,
    10
  ),
  (
    'IT Help Desk',
    'Help with campus accounts, Wi-Fi, and devices.',
    '9:00 AM – 3:00 PM',
    FALSE,
    0,
    0
  )
ON CONFLICT (name) DO NOTHING;