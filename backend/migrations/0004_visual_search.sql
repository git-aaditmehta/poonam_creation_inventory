-- Migration: Visual Search Infrastructure
-- Adds embedding tracking column to plated_jewelry for Cloudflare Vectorize integration.
-- This column tracks WHEN an item's CLIP embedding was generated, enabling:
--   1. Fast backfill queries (find items missing embeddings)
--   2. Status dashboard (indexed vs total counts)
--   3. Re-embedding tracking after image replacement

ALTER TABLE plated_jewelry ADD COLUMN embedding_generated_at TEXT DEFAULT NULL;

-- Partial index for fast backfill queue lookup:
-- Only indexes non-deleted items that have images, making
-- "SELECT ... WHERE embedding_generated_at IS NULL" near-instant.
CREATE INDEX IF NOT EXISTS idx_plated_jewelry_embedding
  ON plated_jewelry(embedding_generated_at)
  WHERE is_deleted = 0 AND image_key IS NOT NULL;
