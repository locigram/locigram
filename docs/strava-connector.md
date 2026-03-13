# Strava → Locigram Connector

Ingests cycling, running, swimming, and other workout activities from Strava.
Supports real-time webhook notifications and historical backfill.

## Architecture

```
Strava Activity Saved → Strava Webhook → POST /api/webhook/strava
  → Fetch Activity Detail → Transform → Locigram Pipeline → Postgres + Qdrant + Memgraph
```

For historical data:
```
POST /api/strava/backfill → Paginate Strava API → Transform each → Ingest
```

## Setup

### 1. Create a Strava API Application

1. Go to https://www.strava.com/settings/api
2. Create an app:
   - **Website:** `https://locigram.ai`
   - **Authorization Callback Domain:** `mcp.locigram.ai`
3. Note your **Client ID** and **Client Secret**

### 2. Configure Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STRAVA_CLIENT_ID` | Yes | Your Strava app client ID |
| `STRAVA_CLIENT_SECRET` | Yes | Your Strava app client secret |
| `STRAVA_ACCESS_TOKEN` | Yes* | Initial access token (from API settings page) |
| `STRAVA_REFRESH_TOKEN` | Yes* | Refresh token (obtained via OAuth) |
| `STRAVA_VERIFY_TOKEN` | No | Webhook subscription verify token (default: `locigram-strava`) |
| `STRAVA_REDIRECT_URI` | No | OAuth callback URL (default: `https://mcp.locigram.ai/api/strava/callback`) |
| `HEALTH_PERSON_NAME` | No | Name used in SPO triples (default: `Owner`) |

*Either access token or refresh token is required. Refresh token is preferred for long-term use.

### 3. Authorize via OAuth (get refresh token)

Visit: `https://mcp.locigram.ai/api/strava/auth`

This redirects to Strava's OAuth page. After authorizing, you'll get back a JSON response with `STRAVA_ACCESS_TOKEN` and `STRAVA_REFRESH_TOKEN`. Add the refresh token to your environment.

### 4. Register Webhook Subscription

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d callback_url=https://mcp.locigram.ai/api/webhook/strava \
  -d verify_token=locigram-strava
```

Strava will send a GET request to verify the callback URL, then start pushing events.

### 5. Backfill Historical Activities

```bash
# All activities
curl -X POST https://mcp.locigram.ai/api/strava/backfill \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Activities after a specific date
curl -X POST https://mcp.locigram.ai/api/strava/backfill \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"after": "2024-01-01", "detailed": true}'

# With splits data (slower — fetches each activity individually)
curl -X POST https://mcp.locigram.ai/api/strava/backfill \
  -H "Authorization: Bearer $PALACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"detailed": true}'
```

## What Gets Ingested

Each Strava activity becomes a Locigram memory with:

| Field | Value |
|-------|-------|
| **content** | `Morning Run (Run), 5.20 km, 28:15, pace 5:26/km, avg HR 152 bpm, ↑45m, 320 cal` |
| **predicate** | `strava_activity` |
| **sourceRef** | `strava:activity:12345678` (dedup key) |
| **locus** | `personal/health` |
| **durability** | `permanent` |

### Metadata JSONB

| Key | Type | Description |
|-----|------|-------------|
| `strava_id` | number | Strava activity ID |
| `activity_type` | string | Run, Ride, Swim, etc. |
| `activity_name` | string | User-given name |
| `distance_m` | number | Distance in meters |
| `moving_time_s` | number | Moving time in seconds |
| `elapsed_time_s` | number | Total elapsed time |
| `avg_speed_ms` | number | Average speed (m/s) |
| `max_speed_ms` | number | Max speed (m/s) |
| `avg_hr` | number | Average heart rate |
| `max_hr` | number | Max heart rate |
| `avg_cadence` | number | Average cadence (steps/min or rpm) |
| `avg_watts` | number | Average power (cycling) |
| `calories` | number | Calories burned |
| `elevation_gain_m` | number | Total elevation gain |
| `suffer_score` | number | Strava's relative effort score |
| `pr_count` | number | Personal records set |
| `kudos_count` | number | Kudos received |
| `gear` | string | Gear name (shoes, bike) |
| `device` | string | Recording device |
| `has_route` | boolean | Whether GPS route exists |
| `splits` | array | Per-km splits (if detailed) |
| `timezone` | string | Activity timezone |

### Activity Types Supported

Running: Run, TrailRun, VirtualRun, Walk, Hike
Cycling: Ride, VirtualRide, EBikeRide, GravelRide, MountainBikeRide
Swimming: Swim, OpenWaterSwim
Other: WeightTraining, Yoga, Workout, CrossFit, Elliptical, StairStepper, etc.

## Querying Strava Data

```sql
-- All Strava activities
SELECT content, occurred_at, metadata->>'activity_type' as type,
  (metadata->>'distance_m')::numeric / 1000 as km,
  metadata->>'avg_hr' as hr
FROM locigrams
WHERE metadata->>'connector' = 'strava'
ORDER BY occurred_at DESC;

-- Running stats
SELECT occurred_at::date as day,
  (metadata->>'distance_m')::numeric / 1000 as km,
  (metadata->>'moving_time_s')::numeric / 60 as minutes,
  metadata->>'avg_hr' as avg_hr,
  metadata->>'elevation_gain_m' as elevation
FROM locigrams
WHERE metadata->>'connector' = 'strava'
  AND metadata->>'activity_type' IN ('Run', 'TrailRun')
ORDER BY occurred_at DESC;

-- Cross-reference with Apple Health
SELECT s.content as strava_activity,
  h.content as health_metric,
  h.predicate as metric_type
FROM locigrams s
JOIN locigrams h ON h.source_type = 'health'
  AND h.metadata->>'connector' = 'health-auto-export'
  AND h.occurred_at::date = s.occurred_at::date
WHERE s.metadata->>'connector' = 'strava'
ORDER BY s.occurred_at DESC;
```

## Rate Limits

Strava allows 200 requests per 15 minutes and 2,000 per day. The connector tracks requests and auto-throttles when approaching the limit. For large backfills, use `perPage: 200` and expect ~10 pages per batch before hitting the limit.

## Deduplication

Each activity uses `strava:activity:<id>` as its sourceRef. Re-running backfill or receiving duplicate webhooks will safely skip already-ingested activities.
