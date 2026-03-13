/**
 * Transform Strava activities into Locigram RawMemory objects.
 */
import type { RawMemory } from '@locigram/core'
import type { StravaActivity } from './client'

const personName = () => process.env.HEALTH_PERSON_NAME ?? 'Owner'

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatPace(metersPerSecond: number): string {
  if (metersPerSecond <= 0) return '–'
  const secPerKm = 1000 / metersPerSecond
  const min = Math.floor(secPerKm / 60)
  const sec = Math.round(secPerKm % 60)
  return `${min}:${String(sec).padStart(2, '0')}/km`
}

function formatSpeed(metersPerSecond: number): string {
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`
  return `${Math.round(meters)} m`
}

const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike'])
const RIDE_TYPES = new Set(['Ride', 'VirtualRide', 'EBikeRide', 'GravelRide', 'MountainBikeRide', 'Velomobile'])
const SWIM_TYPES = new Set(['Swim', 'OpenWaterSwim'])

function isRunType(type: string): boolean { return RUN_TYPES.has(type) }
function isRideType(type: string): boolean { return RIDE_TYPES.has(type) }

// ── Main transform ────────────────────────────────────────────────────────────

export function transformActivity(activity: StravaActivity): RawMemory {
  const parts: string[] = []
  const type = activity.sport_type ?? activity.type ?? 'Activity'

  // Activity name/type
  parts.push(`${activity.name} (${type})`)

  // Distance
  if (activity.distance > 0) {
    parts.push(formatDistance(activity.distance))
  }

  // Duration
  parts.push(formatDuration(activity.moving_time))

  // Pace or speed (depending on activity type)
  if (activity.average_speed > 0 && activity.distance > 0) {
    if (isRunType(type)) {
      parts.push(`pace ${formatPace(activity.average_speed)}`)
    } else {
      parts.push(`avg ${formatSpeed(activity.average_speed)}`)
    }
  }

  // Heart rate
  if (activity.average_heartrate) {
    parts.push(`avg HR ${Math.round(activity.average_heartrate)} bpm`)
  }

  // Elevation
  if (activity.total_elevation_gain > 0) {
    parts.push(`↑${Math.round(activity.total_elevation_gain)}m`)
  }

  // Calories
  if (activity.calories && activity.calories > 0) {
    parts.push(`${Math.round(activity.calories)} cal`)
  }

  // Power (cycling)
  if (activity.average_watts) {
    parts.push(`${Math.round(activity.average_watts)}W avg`)
  }

  const content = parts.join(', ')
  const start = new Date(activity.start_date)

  // Build summary for objectVal (shorter than content)
  const summaryParts: string[] = []
  if (activity.distance > 0) summaryParts.push(formatDistance(activity.distance))
  summaryParts.push(formatDuration(activity.moving_time))
  if (activity.average_heartrate) summaryParts.push(`HR ${Math.round(activity.average_heartrate)}`)
  if (activity.total_elevation_gain > 0) summaryParts.push(`↑${Math.round(activity.total_elevation_gain)}m`)

  // Splits metadata (running)
  const splitsData = activity.splits_metric?.map(s => ({
    split: s.split,
    distance_m: Math.round(s.distance),
    pace: formatPace(s.average_speed),
    elapsed_s: s.elapsed_time,
    hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
    elevation_m: Math.round(s.elevation_difference),
  }))

  return {
    content,
    sourceType: 'health' as any,
    sourceRef: `strava:activity:${activity.id}`,
    occurredAt: start,
    metadata: {
      connector: 'strava',
      strava_id: activity.id,
      activity_type: type,
      activity_name: activity.name,
      distance_m: Math.round(activity.distance),
      moving_time_s: activity.moving_time,
      elapsed_time_s: activity.elapsed_time,
      avg_speed_ms: activity.average_speed,
      max_speed_ms: activity.max_speed,
      avg_hr: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
      max_hr: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
      avg_cadence: activity.average_cadence ?? null,
      avg_watts: activity.average_watts ?? null,
      calories: activity.calories ? Math.round(activity.calories) : null,
      elevation_gain_m: Math.round(activity.total_elevation_gain),
      suffer_score: activity.suffer_score ?? null,
      pr_count: activity.pr_count ?? null,
      kudos_count: activity.kudos_count,
      achievement_count: activity.achievement_count,
      gear: activity.gear?.name ?? null,
      device: activity.device_name ?? null,
      has_route: !!(activity.map?.summary_polyline),
      start_latlng: activity.start_latlng ?? null,
      timezone: activity.timezone,
      splits: splitsData ?? null,
      description: activity.description ?? null,
    },
    preClassified: {
      locus: 'personal/health',
      entities: [personName()],
      isReference: false,
      importance: 'normal' as const,
      category: 'observation',
      subject: personName(),
      predicate: 'strava_activity',
      objectVal: `${type}: ${summaryParts.join(', ')}`,
      durabilityClass: 'permanent',
    },
  }
}
