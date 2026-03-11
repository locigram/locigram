/**
 * Maintenance Scheduler — unified in-process cron for all periodic tasks
 *
 * Replaces external K8s CronJobs with built-in scheduling.
 * All tasks are idempotent and safe to run concurrently across palace IDs.
 *
 * Default schedules (configurable via env vars):
 *   LOCIGRAM_CRON_SWEEP       = "0 2 * * *"      (daily 2am — truth decay)
 *   LOCIGRAM_CRON_DURABILITY  = "0 0,6,12,18 * * *" (every 6h — TTL lifecycle)
 *   LOCIGRAM_CRON_DEDUP       = "30 3 * * *"     (daily 3:30am — dedup sweep)
 *   LOCIGRAM_CRON_CLUSTER     = "0 3 * * 0"      (weekly Sunday 3am — clustering)
 *   LOCIGRAM_CRON_NOISE       = "0 4 * * *"      (daily 4am — noise reassessment)
 *
 * Set LOCIGRAM_MAINTENANCE_DISABLED=true to disable all maintenance tasks.
 * Set individual LOCIGRAM_CRON_<NAME>=disabled to skip specific tasks.
 */

import { CronJob } from 'cron'
import { runSweep, runDurabilityLifecycle, runClusterAnalysis } from '@locigram/truth'
import { runDedup, runNoiseAssessment } from '@locigram/pipeline'
import type { DB } from '@locigram/db'
import type { PipelineConfig } from '@locigram/pipeline'

export interface MaintenanceConfig {
  db:             DB
  palaceId:       string
  pipelineConfig: PipelineConfig
}

interface TaskDef {
  name:       string
  envKey:     string
  defaultCron: string
  run:        () => Promise<void>
}

export function startMaintenance(config: MaintenanceConfig): () => void {
  const { db, palaceId, pipelineConfig } = config

  if (process.env.LOCIGRAM_MAINTENANCE_DISABLED === 'true') {
    console.log('[maintenance] disabled via LOCIGRAM_MAINTENANCE_DISABLED')
    return () => {}
  }

  const tasks: TaskDef[] = [
    {
      name: 'sweep',
      envKey: 'LOCIGRAM_CRON_SWEEP',
      defaultCron: '0 2 * * *',
      run: async () => { await runSweep(db, palaceId) },
    },
    {
      name: 'durability',
      envKey: 'LOCIGRAM_CRON_DURABILITY',
      defaultCron: '0 0,6,12,18 * * *',
      run: async () => { await runDurabilityLifecycle(db, palaceId) },
    },
    {
      name: 'dedup',
      envKey: 'LOCIGRAM_CRON_DEDUP',
      defaultCron: '30 3 * * *',
      run: async () => { await runDedup(db, palaceId) },
    },
    {
      name: 'cluster',
      envKey: 'LOCIGRAM_CRON_CLUSTER',
      defaultCron: '0 3 * * 0',
      run: async () => { await runClusterAnalysis(db, palaceId) },
    },
    {
      name: 'noise',
      envKey: 'LOCIGRAM_CRON_NOISE',
      defaultCron: '0 4 * * *',
      run: async () => { await runNoiseAssessment(db, palaceId, pipelineConfig) },
    },
  ]

  const jobs: CronJob[] = []

  for (const task of tasks) {
    const schedule = process.env[task.envKey] ?? task.defaultCron

    if (schedule === 'disabled') {
      console.log(`[maintenance] ${task.name} — disabled`)
      continue
    }

    let running = false

    const job = CronJob.from({
      cronTime: schedule,
      onTick: async () => {
        if (running) {
          console.log(`[maintenance] ${task.name} — skipped (previous run still active)`)
          return
        }
        running = true
        const start = Date.now()
        try {
          console.log(`[maintenance] ${task.name} — starting`)
          await task.run()
          console.log(`[maintenance] ${task.name} — completed in ${Date.now() - start}ms`)
        } catch (err: any) {
          console.error(`[maintenance] ${task.name} — failed:`, err.message)
        } finally {
          running = false
        }
      },
      start: true,
    })

    jobs.push(job)
    console.log(`[maintenance] ${task.name} — scheduled (${schedule})`)
  }

  console.log(`[maintenance] ${jobs.length} tasks scheduled`)

  return () => {
    for (const job of jobs) job.stop()
    console.log('[maintenance] stopped')
  }
}
