# Apple Health → Locigram Connector

Ingests health data from Apple Watch/iPhone via the [Health Auto Export](https://www.healthyapps.dev/) iOS app.
Supports 150+ metrics, workouts with GPS routes, sleep analysis, and automatic batch syncing —
all stored with precise timestamps for trend analysis and cross-referencing with other personal data.

## Architecture

```
Apple Watch → HealthKit (iPhone) → Health Auto Export app (periodic sync)
  → POST /api/webhook/hae → Locigram pipeline → Postgres + Qdrant + Memgraph
```

The app handles all HealthKit querying, JSON formatting, and HTTP delivery.
Locigram's `/api/webhook/hae` endpoint accepts the app's native JSON format directly —
no manual iOS Shortcuts needed.

## Setup

### 1. Install the App

[Health Auto Export](https://apps.apple.com/app/id1115567461) — $3 on the App Store, 7-day free trial.

### 2. Create Health Metrics Automation

Open Health Auto Export → **Automations** → **+** → **REST API**

| Setting | Value |
|---------|-------|
| **URL** | `https://your-locigram-host/api/webhook/hae` |
| **Headers** | `Authorization: Bearer <your_palace_token>` |
| **Data Type** | Health Metrics |
| **Export Format** | JSON |
| **Export Version** | Version 2 |
| **Batch Requests** | ON |
| **Sync Cadence** | Every 6 hours (recommended) |

Select **all metrics** you want tracked — steps, heart rate, resting HR, HRV, VO2 max,
blood oxygen, exercise time, stand hours, flights climbed, walking speed, body measurements, etc.

### 3. Create Workouts Automation (Optional)

Create a **second** REST API automation with the same URL and auth, but set **Data Type** to **Workouts**.

| Setting | Value |
|---------|-------|
| **Include Route Data** | ON (for GPS tracks) |
| **Include Workout Metrics** | ON (HR during workout) |

### 4. Backfill Historical Data

Hit **Manual Export** with a past date range to import history.
Dedup is automatic — re-syncing the same dates won't create duplicates.

### 5. Verify

```bash
curl -s "https://your-locigram-host/api/webhook/hae" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data": {"metrics": []}}' 
# → {"ok":true,"ingested":0,"message":"No data points in payload"}
```

## What Gets Ingested

### Health Metrics (150+)

The endpoint handles the app's full metric catalog with typed parsing for special formats:

| Metric Type | Fields Stored | Example |
|-------------|---------------|---------|
| **Heart Rate** | Avg, Min, Max per interval | `avg 72 bpm (min 55, max 112)` |
| **Sleep Analysis** | deep, REM, core, awake minutes + bed times | `5.8h sleep (deep 68min, REM 82min)` |
| **Blood Pressure** | systolic, diastolic | `120/80 mmHg` |
| **All others** | qty + units | `8,421 count`, `42 ms`, `98 %` |

Common metrics: `step_count`, `heart_rate`, `resting_heart_rate`, `heart_rate_variability`,
`vo2max`, `active_energy`, `apple_exercise_time`, `apple_stand_time`, `blood_oxygen_saturation`,
`walking_speed`, `flights_climbed`, `walking_running_distance`, `respiratory_rate`,
`weight_body_mass`, `body_fat_percentage`, `time_in_daylight`, `environmental_audio`,
`mindful_minutes`, `apple_sleeping_wrist_temperature`, and 100+ more.

### Workouts

| Field | Description |
|-------|-------------|
| `name` | Workout type (Walking, Running, Cycling, etc.) |
| `duration` | Duration in seconds |
| `distance` | Distance in meters |
| `activeEnergy` | Active calories burned |
| `avgHeartRate` / `maxHeartRate` | Heart rate during workout |
| `stepCount` | Steps during workout |
| `route` | GPS coordinates (if available) |

## Data Model

Every health data point becomes a Locigram memory with:

- **`content`** — Human-readable summary (e.g., `"Steps: 8,421 count"`)
- **`predicate`** — Metric name (e.g., `step_count`, `heart_rate`, `workout`)
- **`subject`** — Person name (configured via `HEALTH_PERSON_NAME` env var)
- **`objectVal`** — Value string for SPO triple
- **`sourceRef`** — Dedup key: `hae:<metric>:<ISO timestamp>` (prevents duplicates)
- **`locus`** — `personal/health` (always)
- **`durabilityClass`** — `permanent` (health data never decays)
- **`metadata`** — Full raw JSONB with numeric values for SQL analytics

### Metadata JSONB Keys

| Key | Present On | Type |
|-----|-----------|------|
| `value` | Generic metrics | number |
| `hr_avg`, `hr_min`, `hr_max` | Heart rate | number |
| `deep_min`, `rem_min`, `core_min`, `awake_min` | Sleep | number |
| `in_bed_start`, `in_bed_end`, `sleep_start`, `sleep_end` | Sleep | ISO string |
| `systolic`, `diastolic` | Blood pressure | number |
| `workout_type`, `duration_sec`, `distance_m`, `active_energy` | Workouts | varies |
| `avg_hr`, `max_hr`, `step_count`, `has_route` | Workouts | varies |
| `metric` | All | string (metric name) |
| `units` | All | string |
| `source_device` | All | string (e.g., "Apple Watch") |
| `connector` | All | `"health-auto-export"` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_PERSON_NAME` | `Owner` | Name used as subject in SPO triples |

## SQL Views for Trend Analysis

These views query the raw health data for patterns. Create them on your Locigram Postgres instance.

### Hourly Activity Pattern (find dead zones)

```sql
CREATE OR REPLACE VIEW health_hourly_pattern AS
SELECT 
  EXTRACT(hour FROM occurred_at AT TIME ZONE 'America/Los_Angeles')::int as hour,
  ROUND(AVG((metadata->>'value')::numeric) FILTER (WHERE predicate = 'step_count')) as avg_steps,
  ROUND(AVG((metadata->>'hr_avg')::numeric) FILTER (WHERE predicate = 'heart_rate'), 1) as avg_hr,
  COUNT(DISTINCT occurred_at::date) as days_sampled
FROM locigrams
WHERE source_type = 'health'
  AND metadata->>'connector' = 'health-auto-export'
GROUP BY EXTRACT(hour FROM occurred_at AT TIME ZONE 'America/Los_Angeles')::int
ORDER BY hour;
```

### Sleep Quality Over Time

```sql
CREATE OR REPLACE VIEW health_sleep_quality AS
SELECT 
  occurred_at::date as night,
  (metadata->>'deep_min')::numeric as deep_min,
  (metadata->>'rem_min')::numeric as rem_min,
  (metadata->>'core_min')::numeric as core_min,
  (metadata->>'awake_min')::numeric as awake_min,
  (metadata->>'total_sleep_min')::numeric as total_sleep_min,
  content
FROM locigrams
WHERE predicate = 'sleep_analysis'
  AND source_type = 'health'
ORDER BY occurred_at DESC;
```

### Daily Resting HR + HRV Trend

```sql
CREATE OR REPLACE VIEW health_vitals_trend AS
SELECT 
  occurred_at::date as day,
  MAX(CASE WHEN predicate = 'resting_heart_rate' THEN (metadata->>'value')::numeric END) as resting_hr,
  MAX(CASE WHEN predicate = 'heart_rate_variability' THEN (metadata->>'value')::numeric END) as hrv_ms,
  MAX(CASE WHEN predicate = 'blood_oxygen_saturation' THEN (metadata->>'value')::numeric END) as spo2_pct,
  MAX(CASE WHEN predicate = 'vo2max' THEN (metadata->>'value')::numeric END) as vo2max
FROM locigrams
WHERE source_type = 'health'
  AND predicate IN ('resting_heart_rate', 'heart_rate_variability', 'blood_oxygen_saturation', 'vo2max')
GROUP BY occurred_at::date
ORDER BY day DESC;
```

### Cross-Reference: Activity vs Browsing/Location

```sql
-- What were you doing during your lowest-energy periods?
CREATE OR REPLACE VIEW health_activity_correlation AS
SELECT 
  h.occurred_at,
  h.predicate as metric,
  h.object_val as value,
  LEFT(a.content, 120) as concurrent_activity,
  a.source_type as activity_type
FROM locigrams h
LEFT JOIN LATERAL (
  SELECT content, source_type 
  FROM locigrams 
  WHERE source_type IN ('browsing', 'location', 'calendar', 'llm-session')
    AND occurred_at BETWEEN h.occurred_at - interval '15 min' AND h.occurred_at + interval '15 min'
    AND palace_id = h.palace_id
  ORDER BY occurred_at
  LIMIT 1
) a ON true
WHERE h.source_type = 'health'
  AND h.metadata->>'connector' = 'health-auto-export'
ORDER BY h.occurred_at DESC;
```

### Walk Opportunity Finder

```sql
-- Low-activity work-hour slots = walking opportunities
CREATE OR REPLACE VIEW health_walk_opportunities AS
SELECT 
  EXTRACT(hour FROM occurred_at AT TIME ZONE 'America/Los_Angeles')::int as hour,
  ROUND(AVG((metadata->>'value')::numeric)) as avg_steps,
  COUNT(*) as samples,
  CASE 
    WHEN AVG((metadata->>'value')::numeric) < 100 THEN '🔴 sedentary — walk opportunity'
    WHEN AVG((metadata->>'value')::numeric) < 500 THEN '🟡 low activity'
    WHEN AVG((metadata->>'value')::numeric) < 1000 THEN '🟢 moderate'
    ELSE '💪 active'
  END as recommendation
FROM locigrams
WHERE predicate = 'step_count'
  AND source_type = 'health'
  AND EXTRACT(hour FROM occurred_at AT TIME ZONE 'America/Los_Angeles') BETWEEN 8 AND 18
GROUP BY EXTRACT(hour FROM occurred_at AT TIME ZONE 'America/Los_Angeles')::int
HAVING COUNT(*) >= 3
ORDER BY avg_steps ASC;
```

## Deduplication

Each data point gets a sourceRef of `hae:<metric_name>:<ISO_timestamp>`. The pipeline checks
for existing sourceRefs before storing. Re-syncing the same date range is safe — duplicates
are automatically skipped.

## Querying Health Data

### Via Locigram MCP (semantic)
```
memory_recall("how's my sleep been this week?", locus: "personal/health")
```

### Via Postgres (structured)
```sql
-- All health data, newest first
SELECT predicate, object_val, occurred_at, metadata
FROM locigrams WHERE source_type = 'health' ORDER BY occurred_at DESC;

-- Specific metric
SELECT * FROM locigrams WHERE predicate = 'resting_heart_rate' ORDER BY occurred_at DESC;

-- Workouts
SELECT * FROM locigrams WHERE predicate = 'workout' ORDER BY occurred_at DESC;
```
