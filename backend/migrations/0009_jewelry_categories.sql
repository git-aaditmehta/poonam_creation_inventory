-- Jewelry types (agreed 2026-11-21): the groups shown as chips in Plated / Raw Jewelry and in Scan.
-- A design belongs to a type when its code starts with the type's letters ("NK 101" -> Necklace set).
-- Owner can add more types later (Materials & Categories). Not related to Costing categories.
-- scan_tagged: 1 when every Scan fingerprint of this type carries the type (older fingerprints of a new type were
-- learned as "other"; the server re-labels them the first time someone scans with that type selected).
CREATE TABLE IF NOT EXISTS jewelry_categories (
  prefix TEXT PRIMARY KEY CHECK (prefix GLOB '[A-Z]*' AND length(prefix) BETWEEN 1 AND 5),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  scan_tagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO jewelry_categories (prefix, name, sort_order, scan_tagged) VALUES
  ('ER', 'Earring', 1, 1),
  ('PS', 'Stud', 2, 1),
  ('JK', 'Jhumka', 3, 1),
  ('BR', 'Bracelet', 4, 1),
  ('PD', 'Pendant set', 5, 1),
  ('NK', 'Necklace set', 6, 0),
  ('HF', 'Half Kada', 7, 0),
  ('HP', 'Hathpan', 8, 0),
  ('MP', 'Mathapatti', 9, 0),
  ('KD', 'Kada', 10, 0),
  ('BG', 'Bangles', 11, 0);
