-- GIN indexes for array + JSONB columns
-- Drizzle Kit doesn't support GIN natively — handled manually

CREATE INDEX IF NOT EXISTS locigrams_entities_gin_idx
  ON locigrams USING GIN(entities);

CREATE INDEX IF NOT EXISTS locigrams_metadata_gin_idx
  ON locigrams USING GIN(metadata);

CREATE INDEX IF NOT EXISTS truths_entities_gin_idx
  ON truths USING GIN(entities);

CREATE INDEX IF NOT EXISTS entities_aliases_gin_idx
  ON entities USING GIN(aliases);

CREATE INDEX IF NOT EXISTS entities_metadata_gin_idx
  ON entities USING GIN(metadata);
