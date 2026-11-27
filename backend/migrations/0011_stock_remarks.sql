-- Optional remarks on a stock movement (agreed 2026-11-27), e.g. "Sold to Kunalji" or "From Ravi karigar, lot 12".
-- One new column, empty for every existing row (old operations stay exactly as they are). Nothing else changes.
ALTER TABLE transactions ADD COLUMN remarks TEXT DEFAULT NULL;
