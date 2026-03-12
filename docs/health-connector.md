# Apple Health → Locigram Connector

Ingests granular health data from Apple Watch/iPhone via iOS Shortcuts automation.
48 data points per day (30-minute intervals, 24 hours) including sleep stages,
heart rate, steps, and activity — all stored with precise timestamps for trend analysis.

## Architecture

```
Apple Watch → HealthKit (iPhone) → iOS Shortcut (nightly 11:30pm)
  → POST /api/webhook/health → Locigram pipeline → Postgres + Qdrant + Memgraph
```

No third-party apps. No subscriptions. Native iOS Shortcuts has full HealthKit read access.

## Data Collected Per 30-Minute Slot

| Metric | HealthKit Type | Aggregation |
|--------|---------------|-------------|
| Steps | `HKQuantityTypeIdentifierStepCount` | sum |
| Heart Rate (avg/min/max) | `HKQuantityTypeIdentifierHeartRate` | avg, min, max |
| Active Calories | `HKQuantityTypeIdentifierActiveEnergyBurned` | sum |
| Standing | `HKCategoryTypeIdentifierAppleStandHour` | boolean |
| HRV (SDNN) | `HKQuantityTypeIdentifierHeartRateVariabilitySDNN` | latest |
| Sleep Stage | `HKCategoryTypeIdentifierSleepAnalysis` | awake/core/deep/rem |
| Resting HR | `HKQuantityTypeIdentifierRestingHeartRate` | daily (one value) |

**Daily output:** 48 locigrams (one per 30-min slot), ~1,440/month.

## Payload Format

Each POST sends a batch of 48 memories:

```json
{
  "memories": [
    {
      "content": "12:00am–12:30am: 0 steps, avg HR 56bpm (min 52, max 61), sleep: deep, HRV 45ms",
      "occurredAt": "2026-03-12T07:00:00Z",
      "sourceRef": "health:2026-03-12:00:00",
      "preClassified": {
        "subject": "Andrew Le",
        "predicate": "health_slot",
        "objectVal": "0 steps, 56bpm avg HR, deep sleep",
        "entities": ["Andrew Le"],
        "importance": "normal",
        "durabilityClass": "permanent",
        "category": "observation"
      },
      "metadata": {
        "hour": 0, "minute": 0,
        "steps": 0,
        "hr_avg": 56, "hr_min": 52, "hr_max": 61,
        "active_cal": 0,
        "standing": false,
        "hrv": 45,
        "sleep_stage": "deep",
        "is_sleeping": true
      }
    },
    {
      "content": "2:00pm–2:30pm: 89 steps, avg HR 74bpm (min 68, max 81), standing: no, 12 active cal",
      "occurredAt": "2026-03-12T21:00:00Z",
      "sourceRef": "health:2026-03-12:14:00",
      "preClassified": {
        "subject": "Andrew Le",
        "predicate": "health_slot",
        "objectVal": "89 steps, 74bpm avg HR, not standing",
        "entities": ["Andrew Le"],
        "importance": "normal",
        "durabilityClass": "permanent",
        "category": "observation"
      },
      "metadata": {
        "hour": 14, "minute": 0,
        "steps": 89,
        "hr_avg": 74, "hr_min": 68, "hr_max": 81,
        "active_cal": 12,
        "standing": false,
        "hrv": null,
        "sleep_stage": null,
        "is_sleeping": false
      }
    }
  ],
  "defaults": {
    "sourceType": "health",
    "locus": "personal/health",
    "connector": "health"
  }
}
```

## iOS Shortcut Build Guide

### Prerequisites
- iPhone with iOS 17+ and Shortcuts app
- Apple Watch paired (for HR, HRV, sleep stage data)
- HealthKit permissions granted to Shortcuts
- Locigram server URL and palace API token

### Step-by-Step Build

#### 1. Create the Shortcut
- Open **Shortcuts** app → tap **+** → name it "Health → Locigram"

#### 2. Set Variables
Add these **Text** actions at the top:

| Variable | Value |
|----------|-------|
| `ServerURL` | `https://your-locigram-server/api/webhook/health` |
| `APIToken` | Your palace API token (or store in Keychain) |
| `Today` | Format Date (Current Date, `yyyy-MM-dd`) |
| `PersonName` | `Andrew Le` |

#### 3. Build the Time Loop

**Repeat 48 times** (index variable: `SlotIndex`):

Inside the loop:

```
① Calculate slot times:
   - Set "HourNum" = (SlotIndex - 1) ÷ 2 (round down)
   - Set "MinNum" = ((SlotIndex - 1) mod 2) × 30
   - Set "SlotStart" = Date from "Today HourNum:MinNum"  
   - Set "SlotEnd" = SlotStart + 30 minutes

② Query HealthKit for each metric:
   - "Find Health Samples" where:
     Type = Steps, Start Date ≥ SlotStart, End Date < SlotEnd
     → Sum the values → store as "SlotSteps"
   
   - "Find Health Samples" where:
     Type = Heart Rate, Start Date ≥ SlotStart, End Date < SlotEnd
     → Calculate Average → "HRAvg"
     → Calculate Minimum → "HRMin"  
     → Calculate Maximum → "HRMax"
   
   - "Find Health Samples" where:
     Type = Active Energy, Start Date ≥ SlotStart, End Date < SlotEnd
     → Sum → "ActiveCal"
   
   - "Find Health Samples" where:
     Type = Heart Rate Variability, Start Date ≥ SlotStart, End Date < SlotEnd
     → Get Last → "HRV"
   
   - "Find Health Samples" where:
     Type = Sleep Analysis, Start Date ≥ SlotStart, End Date < SlotEnd
     → Get Last → "SleepStage" (InBed/Asleep/Awake/Core/Deep/REM)

③ Build the content string:
   If SleepStage is not empty:
     "{HourNum}:{MinNum} – {steps} steps, avg HR {HRAvg}bpm (min {HRMin}, max {HRMax}), sleep: {SleepStage}, HRV {HRV}ms"
   Otherwise:
     "{HourNum}:{MinNum} – {steps} steps, avg HR {HRAvg}bpm (min {HRMin}, max {HRMax}), standing: {standing}, {ActiveCal} active cal"

④ Build JSON object for this slot:
   Use "Dictionary" action:
   {
     "content": <content string>,
     "occurredAt": <SlotStart in ISO 8601>,
     "sourceRef": "health:{Today}:{HourNum}:{MinNum}",
     "preClassified": {
       "subject": PersonName,
       "predicate": "health_slot",
       "objectVal": <summary>,
       "entities": [PersonName],
       "importance": "normal",
       "durabilityClass": "permanent",
       "category": "observation"
     },
     "metadata": {
       "hour": HourNum,
       "minute": MinNum,
       "steps": SlotSteps,
       "hr_avg": HRAvg,
       "hr_min": HRMin,
       "hr_max": HRMax,
       "active_cal": ActiveCal,
       "standing": <bool>,
       "hrv": HRV,
       "sleep_stage": SleepStage,
       "is_sleeping": <bool>
     }
   }

⑤ Append to "AllSlots" list variable
```

#### 4. Build Final Payload & POST

After the loop:

```
① Build "Payload" dictionary:
   {
     "memories": AllSlots,
     "defaults": {
       "sourceType": "health",
       "locus": "personal/health",
       "connector": "health"
     }
   }

② "Get Contents of URL":
   URL: ServerURL
   Method: POST
   Headers:
     Content-Type: application/json
     Authorization: Bearer {APIToken}
   Request Body: JSON → Payload
```

#### 5. Set Up Automation

- Open **Shortcuts** → **Automation** tab
- Tap **+** → **Time of Day** → **11:30 PM** → **Daily**
- Run "Health → Locigram"
- Toggle **Run Immediately** (no confirmation prompt)

### Tips

- **First run:** Grant all HealthKit permissions when prompted. The Shortcut will ask for
  Steps, Heart Rate, Active Energy, HRV, and Sleep Analysis access.
- **No Apple Watch?** Steps and Active Cal still work from iPhone. HR, HRV, and Sleep
  will be empty for those slots.
- **Battery impact:** Minimal — one Shortcut run at 11:30pm, reads cached HealthKit data.
- **Dedup safety:** Each slot has a unique `sourceRef` (`health:2026-03-12:14:00`), so
  re-running the Shortcut won't create duplicates.
- **Time zones:** `occurredAt` should be UTC. The Shortcut's "Format Date" with
  ISO 8601 format and UTC timezone handles this.

## SQL Views for Trend Analysis

### Hourly Activity Pattern (find dead zones)

```sql
CREATE OR REPLACE VIEW health_hourly_pattern AS
SELECT 
  (metadata->>'hour')::int as hour,
  (metadata->>'minute')::int as minute,
  ROUND(AVG((metadata->>'steps')::numeric)) as avg_steps,
  ROUND(AVG((metadata->>'hr_avg')::numeric), 1) as avg_hr,
  ROUND(AVG(NULLIF((metadata->>'active_cal')::numeric, 0)), 1) as avg_cal,
  ROUND(AVG(CASE WHEN (metadata->>'standing')::boolean THEN 1 ELSE 0 END) * 100, 1) as pct_standing,
  COUNT(*) as days_sampled
FROM locigrams
WHERE predicate = 'health_slot'
  AND source_type = 'health'
GROUP BY (metadata->>'hour')::int, (metadata->>'minute')::int
ORDER BY hour, minute;
```

### Sleep Quality Over Time

```sql
CREATE OR REPLACE VIEW health_sleep_quality AS
SELECT 
  DATE(occurred_at AT TIME ZONE 'America/Los_Angeles') as night,
  COUNT(*) FILTER (WHERE metadata->>'sleep_stage' = 'deep') * 30 as deep_min,
  COUNT(*) FILTER (WHERE metadata->>'sleep_stage' = 'rem') * 30 as rem_min,
  COUNT(*) FILTER (WHERE metadata->>'sleep_stage' = 'core') * 30 as core_min,
  COUNT(*) FILTER (WHERE metadata->>'sleep_stage' = 'awake') * 30 as awake_min,
  COUNT(*) FILTER (WHERE metadata->>'is_sleeping' = 'true') * 30 as total_sleep_min,
  ROUND(AVG(NULLIF((metadata->>'hr_avg')::numeric, 0)) FILTER (WHERE metadata->>'is_sleeping' = 'true'), 1) as avg_sleeping_hr,
  ROUND(MIN(NULLIF((metadata->>'hr_min')::numeric, 0)) FILTER (WHERE metadata->>'is_sleeping' = 'true'), 1) as lowest_sleeping_hr
FROM locigrams
WHERE predicate = 'health_slot'
  AND source_type = 'health'
  AND metadata->>'is_sleeping' = 'true'
GROUP BY DATE(occurred_at AT TIME ZONE 'America/Los_Angeles')
ORDER BY night DESC;
```

### Daily Step Totals + Trend

```sql
CREATE OR REPLACE VIEW health_daily_steps AS
SELECT 
  DATE(occurred_at AT TIME ZONE 'America/Los_Angeles') as day,
  SUM((metadata->>'steps')::int) as total_steps,
  ROUND(AVG((metadata->>'hr_avg')::numeric), 1) as avg_hr_all_day,
  SUM((metadata->>'active_cal')::int) as total_active_cal,
  ROUND(AVG(NULLIF((metadata->>'hrv')::numeric, 0)), 1) as avg_hrv
FROM locigrams
WHERE predicate = 'health_slot'
  AND source_type = 'health'
GROUP BY DATE(occurred_at AT TIME ZONE 'America/Los_Angeles')
ORDER BY day DESC;
```

### Cross-Reference: Activity vs Browsing/Location

```sql
-- What were you doing during your lowest-activity periods?
CREATE OR REPLACE VIEW health_activity_correlation AS
SELECT 
  h.occurred_at,
  (h.metadata->>'hour')::int || ':' || LPAD((h.metadata->>'minute')::text, 2, '0') as time_slot,
  (h.metadata->>'steps')::int as steps,
  (h.metadata->>'hr_avg')::numeric as hr,
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
WHERE h.predicate = 'health_slot'
  AND h.source_type = 'health'
ORDER BY h.occurred_at DESC;
```

### Walk Opportunity Finder

```sql
-- Consistently low-activity slots during work hours = walking opportunities
CREATE OR REPLACE VIEW health_walk_opportunities AS
SELECT 
  (metadata->>'hour')::int as hour,
  (metadata->>'minute')::int as minute,
  ROUND(AVG((metadata->>'steps')::numeric)) as avg_steps,
  ROUND(AVG((metadata->>'hr_avg')::numeric), 1) as avg_hr,
  COUNT(*) as days_sampled,
  CASE 
    WHEN AVG((metadata->>'steps')::numeric) < 100 THEN '🔴 sedentary — great walk opportunity'
    WHEN AVG((metadata->>'steps')::numeric) < 300 THEN '🟡 low activity — could add movement'
    WHEN AVG((metadata->>'steps')::numeric) < 600 THEN '🟢 moderate'
    ELSE '💪 active'
  END as recommendation
FROM locigrams
WHERE predicate = 'health_slot'
  AND source_type = 'health'
  AND (metadata->>'hour')::int BETWEEN 8 AND 18
  AND (metadata->>'is_sleeping')::text != 'true'
GROUP BY (metadata->>'hour')::int, (metadata->>'minute')::int
HAVING COUNT(*) >= 3  -- need at least 3 days of data
ORDER BY avg_steps ASC;
```
