-- Item IDs that differ only in capitals, spaces or dashes are the same item (agreed 2026-11-19).
-- "PS 365", "ps-365" and "PS365" can no longer exist side by side in the same category. Uniqueness stays
-- per category (Plated and Raw may share an ID). The ID is still stored exactly as typed.
-- Enforced here so two saves at the same moment can never both succeed (the app also checks first and
-- answers with a clear message). Must match ITEM_KEY_SQL in backend/src/utils/itemId.ts.
-- Safe now: Plated/Raw were wiped and Stones/Foil are empty; it would refuse to run if duplicates existed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_plated_jewelry_item_key ON plated_jewelry(REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', ''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_raw_jewelry_item_key ON raw_jewelry(REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', ''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_stones_item_key ON stones(REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', ''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_foil_item_key ON foil(REPLACE(REPLACE(UPPER(TRIM(item_id)), ' ', ''), '-', ''));
