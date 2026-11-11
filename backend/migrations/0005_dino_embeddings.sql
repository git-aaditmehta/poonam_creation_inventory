-- Poonam Creation: On-device visual search (DINOv2) — isolated from the Llama pipeline
-- =====================================================================================
-- Tracks which catalog photos have a DINOv2 vector in the `jewelry-dinov2-384` Vectorize index.
-- Does NOT touch plated_jewelry: the Llama pipeline keeps using plated_jewelry.embedding_generated_at.
--
-- An item is "waiting to be learned" when it has a photo but no row here (or a row from an older
-- model_version). Replacing a photo deletes the row (images upload route), deleting an item
-- deletes the row and its vector (inventory delete route).

CREATE TABLE IF NOT EXISTS dino_embeddings (
  item_uuid TEXT PRIMARY KEY,          -- plated_jewelry.id
  model_version TEXT NOT NULL,         -- e.g. dinov2s-224-cls-v1 (must match the app's model)
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
