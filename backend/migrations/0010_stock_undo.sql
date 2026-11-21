-- Undo in Stock Operations (agreed 2026-11-21). An undo is a NEW stock movement in the opposite direction that
-- points to the movement it reverses (reverses_id); the original row is never changed or deleted (audit stays
-- honest). The unique index lets the database itself guarantee that a movement is undone at most once, even if two
-- people tap Undo at the same moment.
ALTER TABLE transactions ADD COLUMN reverses_id TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_reverses_id ON transactions(reverses_id) WHERE reverses_id IS NOT NULL;
