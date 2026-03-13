/**
 * Strava API client with rate limiting and pagination.
 * Rate limits: 200 requests / 15 min, 2000 / day.
 */
import { getAccessToken } from './auth'

const BASE_URL = 'https://www.strava.com/api/v3'

// Simple rate limiter — track request count
let requestsInWindow = 0
let windowStart = Date.now()
const WINDOW_MS = 15 * 60 * 1000  // 15 minutes
const MAX_PER_WINDOW = 180  // leave some headroom from the 200 limit

async function rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now()
  if (now - windowStart > WINDOW_MS) {
    requestsInWindow = 0
    windowStart = now
  }

  if (requestsInWindow >= MAX_PER_WINDOW) {
    const waitMs = WINDOW_MS - (now - windowStart) + 1000
    console.log(`[strava] Rate limit reached, waiting ${Math.round(waitMs / 1000)}s...`)
    await new Promise(r => setTimeout(r, waitMs))
    requestsInWindow = 0
    windowStart = Date.now()
  }

  requestsInWindow++
  return fetch(url, init)
}

async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = await getAccessToken()
  const url = new URL(`${BASE_URL}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

  const res = await rateLimitedFetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (res.status === 401) {
    throw new Error('Strava: Unauthorized — token may be expired or revoked')
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    throw new Error(`Strava: Rate limited. Retry after ${retryAfter ?? 'unknown'}s`)
  }
  if (!res.ok) {
    throw new Error(`Strava API error: ${res.status} ${await res.text()}`)
  }

  return res.json()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StravaAthlete {
  id: number
  firstname: string
  lastname: string
  city: string
  state: string
  country: string
  measurement_preference: 'feet' | 'meters'
}

export interface StravaActivity {
  id: number
  name: string
  type: string
  sport_type: string
  start_date: string          // ISO 8601 UTC
  start_date_local: string    // ISO 8601 local
  timezone: string
  distance: number            // meters
  moving_time: number         // seconds
  elapsed_time: number        // seconds
  total_elevation_gain: number // meters
  average_speed: number       // m/s
  max_speed: number           // m/s
  average_heartrate?: number
  max_heartrate?: number
  average_cadence?: number
  average_watts?: number
  kilojoules?: number
  calories?: number
  has_heartrate: boolean
  map?: {
    id: string
    summary_polyline: string
    polyline?: string
  }
  gear_id?: string
  gear?: { id: string; name: string; distance: number }
  kudos_count: number
  comment_count: number
  achievement_count: number
  suffer_score?: number
  pr_count?: number
  splits_metric?: Array<{
    distance: number
    elapsed_time: number
    elevation_difference: number
    moving_time: number
    split: number
    average_speed: number
    average_heartrate?: number
    pace_zone: number
  }>
  laps?: Array<{
    id: number
    name: string
    distance: number
    elapsed_time: number
    moving_time: number
    average_speed: number
    average_heartrate?: number
    max_heartrate?: number
    lap_index: number
  }>
  description?: string
  workout_type?: number
  device_name?: string
  start_latlng?: [number, number]
  end_latlng?: [number, number]
}

// ── API Methods ───────────────────────────────────────────────────────────────

export async function getAthlete(): Promise<StravaAthlete> {
  return apiGet('/athlete')
}

/**
 * List activities, newest first. Paginated.
 */
export async function getActivities(opts: {
  after?: number    // epoch seconds
  before?: number   // epoch seconds
  page?: number
  perPage?: number
} = {}): Promise<StravaActivity[]> {
  const params: Record<string, string> = {
    page: String(opts.page ?? 1),
    per_page: String(opts.perPage ?? 50),
  }
  if (opts.after) params.after = String(opts.after)
  if (opts.before) params.before = String(opts.before)
  return apiGet('/athlete/activities', params)
}

/**
 * Get detailed activity (includes splits, laps, segment efforts).
 */
export async function getActivityDetail(id: number): Promise<StravaActivity> {
  return apiGet(`/activities/${id}`, { include_all_efforts: 'false' })
}
