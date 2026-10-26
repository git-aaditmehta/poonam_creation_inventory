-- Poonam Creation: Backfill Existing Master Records into CDC sync_changes
-- ====================================================================
-- Ensures any records inserted directly or via legacy bulk commits
-- are recorded in sync_changes so incremental sync delivers them to clients.

INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
SELECT 
  'stones',
  id,
  'CREATE',
  json_object(
    'id', id,
    'item_id', item_id,
    'quantity', quantity,
    'unit', unit,
    'low_stock_threshold', low_stock_threshold,
    'cost_price_cents', cost_price_cents,
    'is_deleted', is_deleted,
    'created_at', created_at,
    'updated_at', updated_at
  )
FROM stones
WHERE is_deleted = 0
  AND id NOT IN (SELECT entity_id FROM sync_changes WHERE entity_type = 'stones' AND operation = 'CREATE');

INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
SELECT 
  'plated_jewelry',
  id,
  'CREATE',
  json_object(
    'id', id,
    'item_id', item_id,
    'quantity', quantity,
    'unit', unit,
    'low_stock_threshold', low_stock_threshold,
    'cost_price_cents', cost_price_cents,
    'image_key', image_key,
    'thumb_key', thumb_key,
    'is_deleted', is_deleted,
    'created_at', created_at,
    'updated_at', updated_at
  )
FROM plated_jewelry
WHERE is_deleted = 0
  AND id NOT IN (SELECT entity_id FROM sync_changes WHERE entity_type = 'plated_jewelry' AND operation = 'CREATE');

INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
SELECT 
  'raw_jewelry',
  id,
  'CREATE',
  json_object(
    'id', id,
    'item_id', item_id,
    'quantity', quantity,
    'unit', unit,
    'low_stock_threshold', low_stock_threshold,
    'is_deleted', is_deleted,
    'created_at', created_at,
    'updated_at', updated_at
  )
FROM raw_jewelry
WHERE is_deleted = 0
  AND id NOT IN (SELECT entity_id FROM sync_changes WHERE entity_type = 'raw_jewelry' AND operation = 'CREATE');

INSERT INTO sync_changes (entity_type, entity_id, operation, payload)
SELECT 
  'foil',
  id,
  'CREATE',
  json_object(
    'id', id,
    'item_id', item_id,
    'quantity', quantity,
    'unit', unit,
    'low_stock_threshold', low_stock_threshold,
    'cost_price_cents', cost_price_cents,
    'is_deleted', is_deleted,
    'created_at', created_at,
    'updated_at', updated_at
  )
FROM foil
WHERE is_deleted = 0
  AND id NOT IN (SELECT entity_id FROM sync_changes WHERE entity_type = 'foil' AND operation = 'CREATE');
