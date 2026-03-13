/**
 * Health Auto Export app integration.
 * Accepts the exact JSON format from the iOS "Health Auto Export" app
 * and transforms it into Locigram memories with preClassified SPO triples.
 *
 * App format: { data: { metrics?: MetricData[], workouts?: WorkoutData[] } }
 * Each metric has: { name, units, data: [{ qty|Avg|Min|Max|..., date, source }] }
 *
 * Docs: https://help.healthyapps.dev/en/health-auto-export/automations/rest-api
 * Reference: https://github.com/HealthyApps/health-auto-export-server
 */
import { Hono } from 'hono'
import type { RawMemory } from '@locigram/core'

// ── Types matching Health Auto Export's JSON format ────────────────────────────

interface BaseMetric {
  qty: number
  date: string
  source: string
  units?: string
  metadata?: Record<string, string>
}

interface HeartRateMetric {
  Min: number
  Avg: number
  Max: number
  date: string
  source: string
  units?: string
  metadata?: Record<string, string>
}

interface SleepMetric {
  date: string
  inBedStart: string
  inBedEnd: string
  sleepStart: string
  sleepEnd: string
  core: number   // minutes
  rem: number
  deep: number
  awake: number
  inBed: number
  source: string
  units?: string
  metadata?: Record<string, string>
}

interface BloodPressureMetric {
  systolic: number
  diastolic: number
  date: string
  source: string
  units?: string
  metadata?: Record<string, string>
}

interface MetricData {
  name: string
  units: string
  data: (BaseMetric | HeartRateMetric | SleepMetric | BloodPressureMetric)[]
}

interface WorkoutData {
  name: string
  start: string
  end: string
  duration?: number
  activeEnergy?: number
  totalEnergy?: number
  avgHeartRate?: number
  maxHeartRate?: number
  distance?: number
  stepCount?: number
  route?: Array<{ lat: number; lon: number; altitude: number; timestamp: string }>
  [key: string]: unknown
}

interface HAEPayload {
  data: {
    metrics?: MetricData[]
    workouts?: WorkoutData[]
  }
}

// ── Metric name → human-readable label ────────────────────────────────────────

const METRIC_LABELS: Record<string, string> = {
  step_count: 'Steps',
  active_energy: 'Active Energy',
  basal_energy_burned: 'Resting Energy',
  heart_rate: 'Heart Rate',
  resting_heart_rate: 'Resting Heart Rate',
  heart_rate_variability: 'HRV',
  walking_heart_rate: 'Walking Heart Rate',
  cardio_recovery: 'Heart Rate Recovery',
  walking_running_distance: 'Walking + Running Distance',
  flights_climbed: 'Flights Climbed',
  apple_exercise_time: 'Exercise Time',
  apple_stand_time: 'Stand Time',
  apple_stand_hour: 'Stand Hour',
  vo2max: 'VO2 Max',
  sleep_analysis: 'Sleep',
  blood_oxygen_saturation: 'Blood Oxygen',
  respiratory_rate: 'Respiratory Rate',
  body_temperature: 'Body Temperature',
  weight_body_mass: 'Weight',
  body_fat_percentage: 'Body Fat %',
  blood_pressure: 'Blood Pressure',
  blood_glucose: 'Blood Glucose',
  dietary_energy: 'Dietary Energy',
  dietary_water: 'Water Intake',
  mindful_minutes: 'Mindful Minutes',
  environmental_audio: 'Environmental Audio',
  headphone_audio: 'Headphone Audio',
  time_in_daylight: 'Time in Daylight',
  cycling_distance: 'Cycling Distance',
  swimming_distance: 'Swimming Distance',
  apple_sleeping_wrist_temperature: 'Wrist Temperature (Sleep)',
  breathing_disturbances: 'Breathing Disturbances',
  walking_speed: 'Walking Speed',
  walking_step_length: 'Step Length',
  walking_asymmetry_percentage: 'Walking Asymmetry',
  physical_effort: 'Physical Effort',
}

function metricLabel(name: string): string {
  return METRIC_LABELS[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Transform helpers ─────────────────────────────────────────────────────────

function transformMetric(metric: MetricData, personName: string): RawMemory[] {
  const memories: RawMemory[] = []
  const label = metricLabel(metric.name)

  for (const sample of metric.data) {
    const date = new Date(sample.date)
    const dateStr = date.toISOString().split('T')[0]

    // Handle special metric types
    if (metric.name === 'heart_rate') {
      const hr = sample as HeartRateMetric
      memories.push({
        content: `${label}: avg ${hr.Avg} bpm (min ${hr.Min}, max ${hr.Max})`,
        sourceType: 'health' as any,
        sourceRef: `hae:${metric.name}:${date.toISOString()}`,
        occurredAt: date,
        metadata: {
          connector: 'health-auto-export',
          metric: metric.name,
          units: metric.units,
          hr_avg: hr.Avg,
          hr_min: hr.Min,
          hr_max: hr.Max,
          source_device: hr.source,
        },
        preClassified: {
          locus: 'personal/health',
          entities: [personName],
          isReference: false,
          importance: 'normal' as const,
          category: 'observation',
          subject: personName,
          predicate: metric.name,
          objectVal: `avg ${hr.Avg} bpm (min ${hr.Min}, max ${hr.Max})`,
          durabilityClass: 'permanent',
        },
      })
    } else if (metric.name === 'sleep_analysis') {
      const sleep = sample as SleepMetric
      // The app sends sleep stage values in the same unit as metric.units.
      // If units = "hr", values are hours (e.g. core: 2.81 = 2h49m).
      // If units = "min", values are already minutes.
      // Normalize everything to minutes for storage and display.
      const isHours = metric.units === 'hr'
      const deepMin = Math.round(isHours ? sleep.deep * 60 : sleep.deep)
      const remMin = Math.round(isHours ? sleep.rem * 60 : sleep.rem)
      const coreMin = Math.round(isHours ? sleep.core * 60 : sleep.core)
      const awakeMin = Math.round(isHours ? sleep.awake * 60 : sleep.awake)
      const inBedMin = Math.round(isHours ? sleep.inBed * 60 : sleep.inBed)
      const totalSleepMin = deepMin + remMin + coreMin
      const totalHrs = (totalSleepMin / 60).toFixed(1)
      memories.push({
        content: `${label}: ${totalHrs}h total (deep ${deepMin}min, REM ${remMin}min, core ${coreMin}min, awake ${awakeMin}min). In bed ${new Date(sleep.inBedStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })} to ${new Date(sleep.inBedEnd).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })}.`,
        sourceType: 'health' as any,
        sourceRef: `hae:${metric.name}:${date.toISOString()}`,
        occurredAt: date,
        metadata: {
          connector: 'health-auto-export',
          metric: metric.name,
          units: 'min',
          deep_min: deepMin,
          rem_min: remMin,
          core_min: coreMin,
          awake_min: awakeMin,
          in_bed_min: inBedMin,
          total_sleep_min: totalSleepMin,
          in_bed_start: sleep.inBedStart,
          in_bed_end: sleep.inBedEnd,
          sleep_start: sleep.sleepStart,
          sleep_end: sleep.sleepEnd,
          source_device: sleep.source,
        },
        preClassified: {
          locus: 'personal/health',
          entities: [personName],
          isReference: false,
          importance: 'normal' as const,
          category: 'observation',
          subject: personName,
          predicate: 'sleep_analysis',
          objectVal: `${totalHrs}h sleep (deep ${deepMin}min, REM ${remMin}min, core ${coreMin}min)`,
          durabilityClass: 'permanent',
        },
      })
    } else if (metric.name === 'blood_pressure') {
      const bp = sample as BloodPressureMetric
      memories.push({
        content: `${label}: ${bp.systolic}/${bp.diastolic} ${metric.units}`,
        sourceType: 'health' as any,
        sourceRef: `hae:${metric.name}:${date.toISOString()}`,
        occurredAt: date,
        metadata: {
          connector: 'health-auto-export',
          metric: metric.name,
          units: metric.units,
          systolic: bp.systolic,
          diastolic: bp.diastolic,
          source_device: bp.source,
        },
        preClassified: {
          locus: 'personal/health',
          entities: [personName],
          isReference: false,
          importance: 'normal' as const,
          category: 'observation',
          subject: personName,
          predicate: metric.name,
          objectVal: `${bp.systolic}/${bp.diastolic} ${metric.units}`,
          durabilityClass: 'permanent',
        },
      })
    } else {
      // Generic metric (step_count, active_energy, HRV, VO2max, etc.)
      const base = sample as BaseMetric
      const valueStr = Number.isInteger(base.qty) ? base.qty.toLocaleString() : base.qty.toFixed(1)
      memories.push({
        content: `${label}: ${valueStr} ${metric.units}`,
        sourceType: 'health' as any,
        sourceRef: `hae:${metric.name}:${date.toISOString()}`,
        occurredAt: date,
        metadata: {
          connector: 'health-auto-export',
          metric: metric.name,
          units: metric.units,
          value: base.qty,
          source_device: base.source,
        },
        preClassified: {
          locus: 'personal/health',
          entities: [personName],
          isReference: false,
          importance: 'normal' as const,
          category: 'observation',
          subject: personName,
          predicate: metric.name,
          objectVal: `${valueStr} ${metric.units}`,
          durabilityClass: 'permanent',
        },
      })
    }
  }

  return memories
}

function transformWorkout(workout: WorkoutData, personName: string): RawMemory {
  const start = new Date(workout.start)
  const durationMin = workout.duration ? Math.round(workout.duration / 60) : null
  const parts = [`Workout: ${workout.name}`]
  if (durationMin) parts.push(`${durationMin} min`)
  if (workout.activeEnergy) parts.push(`${Math.round(workout.activeEnergy)} cal`)
  if (workout.distance) parts.push(`${(workout.distance / 1000).toFixed(2)} km`)
  if (workout.avgHeartRate) parts.push(`avg HR ${Math.round(workout.avgHeartRate)} bpm`)
  if (workout.stepCount) parts.push(`${workout.stepCount.toLocaleString()} steps`)

  return {
    content: parts.join(', '),
    sourceType: 'health' as any,
    sourceRef: `hae:workout:${start.toISOString()}:${workout.name}`,
    occurredAt: start,
    metadata: {
      connector: 'health-auto-export',
      metric: 'workout',
      workout_type: workout.name,
      duration_sec: workout.duration,
      active_energy: workout.activeEnergy,
      total_energy: workout.totalEnergy,
      avg_hr: workout.avgHeartRate,
      max_hr: workout.maxHeartRate,
      distance_m: workout.distance,
      step_count: workout.stepCount,
      has_route: !!workout.route?.length,
    },
    preClassified: {
      locus: 'personal/health',
      entities: [personName],
      isReference: false,
      importance: 'normal' as const,
      category: 'observation',
      subject: personName,
      predicate: 'workout',
      objectVal: parts.slice(1).join(', '),
      durabilityClass: 'permanent',
    },
  }
}

// ── Route builder ─────────────────────────────────────────────────────────────

export function buildHealthAutoExportRoute(config: { personName?: string } = {}) {
  const route = new Hono()
  const personName = config.personName ?? 'Owner'

  route.post('/', async (c) => {
    try {
      const body = await c.req.json() as HAEPayload
      const palace = c.get('palace')
      const db = c.get('db')
      const pipelineConfig = c.get('pipelineConfig')

      if (!body?.data) {
        return c.json({ error: 'Invalid Health Auto Export payload — expected { data: { metrics?, workouts? } }' }, 400)
      }

      const allMemories: RawMemory[] = []

      // Transform metrics
      if (body.data.metrics?.length) {
        for (const metric of body.data.metrics) {
          if (!metric.data?.length) continue
          const memories = transformMetric(metric, personName)
          allMemories.push(...memories)
        }
      }

      // Transform workouts
      if (body.data.workouts?.length) {
        for (const workout of body.data.workouts) {
          allMemories.push(transformWorkout(workout, personName))
        }
      }

      if (allMemories.length === 0) {
        return c.json({ ok: true, ingested: 0, message: 'No data points in payload' })
      }

      // Set palace_id on all metadata
      for (const mem of allMemories) {
        if (mem.metadata) mem.metadata.palace_id = palace.id
      }

      console.log(`[health-auto-export] Received ${body.data.metrics?.length ?? 0} metric types, ${body.data.workouts?.length ?? 0} workouts → ${allMemories.length} memories`)

      const { ingest } = await import('@locigram/pipeline')
      const result = await ingest(allMemories, db, pipelineConfig)

      return c.json({
        ok: true,
        received: {
          metricTypes: body.data.metrics?.length ?? 0,
          workouts: body.data.workouts?.length ?? 0,
        },
        ingested: result.stored,
        skipped: result.skipped,
        errors: result.errors,
        ids: result.ids,
      })
    } catch (err: any) {
      console.error('[health-auto-export]', err)
      return c.json({ error: err.message }, 500)
    }
  })

  return route
}
