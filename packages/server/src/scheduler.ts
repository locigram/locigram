import { CronJob } from 'cron'
import { connectorInstances, connectorSyncs } from '@locigram/db'
import { eq, and, isNotNull } from 'drizzle-orm'
import { executeSync } from './routes/connectors'
import type { DB } from '@locigram/db'

interface SchedulerOpts {
  db:             DB
  palaceId:       string
  pipelineConfig: unknown
}

interface ManagedJob {
  instanceId: string
  schedule:   string
  job:        CronJob
}

export function startScheduler(opts: SchedulerOpts) {
  const { db, palaceId, pipelineConfig } = opts
  const jobs = new Map<string, ManagedJob>()

  async function loadJobs() {
    const instances = await db
      .select()
      .from(connectorInstances)
      .where(
        and(
          eq(connectorInstances.palaceId, palaceId),
          eq(connectorInstances.status, 'active'),
          eq(connectorInstances.distribution, 'bundled'),
          isNotNull(connectorInstances.schedule),
        )
      )

    // Track which instance IDs are still active
    const activeIds = new Set<string>()

    for (const instance of instances) {
      if (!instance.schedule) continue
      activeIds.add(instance.id)

      const existing = jobs.get(instance.id)

      // If schedule hasn't changed, keep the existing job
      if (existing && existing.schedule === instance.schedule) continue

      // Schedule changed or new instance — stop old job if any, create new one
      if (existing) {
        existing.job.stop()
        console.log(`[scheduler] stopped job for ${instance.name} (schedule changed)`)
      }

      try {
        const job = CronJob.from({
          cronTime: instance.schedule,
          onTick: () => runSync(instance.id, instance.name),
          start: true,
        })

        jobs.set(instance.id, {
          instanceId: instance.id,
          schedule:   instance.schedule,
          job,
        })
        console.log(`[scheduler] scheduled ${instance.name} (${instance.schedule})`)
      } catch (err: any) {
        console.error(`[scheduler] invalid cron for ${instance.name}: ${err.message}`)
      }
    }

    // Stop jobs for instances that are no longer active/scheduled
    for (const [id, managed] of jobs) {
      if (!activeIds.has(id)) {
        managed.job.stop()
        jobs.delete(id)
        console.log(`[scheduler] removed job for ${id} (no longer active)`)
      }
    }
  }

  async function runSync(instanceId: string, instanceName: string) {
    console.log(`[scheduler] running sync for ${instanceName}`)
    try {
      // Re-fetch instance to get latest cursor
      const [instance] = await db
        .select()
        .from(connectorInstances)
        .where(eq(connectorInstances.id, instanceId))
        .limit(1)

      if (!instance || instance.status !== 'active') return

      // Create sync record
      const [sync] = await db.insert(connectorSyncs).values({
        instanceId,
        cursorBefore: instance.cursor,
      }).returning()

      const startTime = Date.now()

      try {
        const result = await executeSync(db, instance, palaceId, pipelineConfig)

        await db.update(connectorSyncs)
          .set({
            status:       'completed',
            completedAt:  new Date(),
            itemsPulled:  result.itemsPulled,
            itemsPushed:  result.itemsPushed,
            itemsSkipped: result.itemsSkipped,
            cursorAfter:  result.cursor ?? null,
            durationMs:   Date.now() - startTime,
          })
          .where(eq(connectorSyncs.id, sync.id))

        await db.update(connectorInstances)
          .set({
            lastSyncAt:  new Date(),
            cursor:      result.cursor ?? instance.cursor,
            itemsSynced: (instance.itemsSynced ?? 0) + result.itemsPushed,
            lastError:   null,
            updatedAt:   new Date(),
          })
          .where(eq(connectorInstances.id, instanceId))

        console.log(`[scheduler] sync complete for ${instanceName}: ${result.itemsPulled} pulled, ${result.itemsPushed} pushed`)
      } catch (err: any) {
        await db.update(connectorSyncs)
          .set({
            status:      'failed',
            completedAt: new Date(),
            error:       err.message,
            durationMs:  Date.now() - startTime,
          })
          .where(eq(connectorSyncs.id, sync.id))

        await db.update(connectorInstances)
          .set({ lastError: err.message, updatedAt: new Date() })
          .where(eq(connectorInstances.id, instanceId))

        console.error(`[scheduler] sync failed for ${instanceName}:`, err.message)
      }
    } catch (err: any) {
      console.error(`[scheduler] unexpected error for ${instanceName}:`, err.message)
    }
  }

  // Initial load
  loadJobs().catch(err => console.error('[scheduler] initial load failed:', err))

  // Re-scan every 5 minutes for new/changed instances
  const rescanInterval = setInterval(() => {
    loadJobs().catch(err => console.error('[scheduler] rescan failed:', err))
  }, 5 * 60 * 1000)

  console.log('[scheduler] started (re-scans every 5 min)')

  return {
    stop() {
      clearInterval(rescanInterval)
      for (const [, managed] of jobs) {
        managed.job.stop()
      }
      jobs.clear()
      console.log('[scheduler] stopped')
    },
  }
}
