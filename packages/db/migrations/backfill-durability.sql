-- Backfill durability_class from existing data
-- Run AFTER migration, on live locigram-postgres

-- Reference items are permanent (never decay)
UPDATE locigrams SET durability_class = 'permanent' WHERE is_reference = true;

-- Decisions, preferences, facts are stable (long-lived)
UPDATE locigrams SET durability_class = 'stable' WHERE is_reference = false AND category IN ('decision', 'preference', 'fact');

-- Everything else stays 'active' (the default)
-- No action needed for active since that's the column default

-- Verify distribution
SELECT durability_class, COUNT(*) FROM locigrams GROUP BY durability_class ORDER BY 1;
