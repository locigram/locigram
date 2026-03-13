/**
 * Backfill historical Strava activities into Locigram.
 * Paginates through the activity list and ingests each one.
 */
import { getActivities, getActivityDetail } from './client'
import { transformActivity } from './transform'

export interface BackfillOptions {
  after?: Date       // only activities after this date
  before?: Date      // only activities before this date
  perPage?: number   // page size (default 50, max 200)
  detailed?: boolean // fetch full activity detail with splits (slower, more API calls)
  db: any
  pipelineConfig: any
}

export async function backfillActivities(opts: BackfillOptions): Promise<{
  total: number
  stored: number
  skipped: number
  errors: string[]
}> {
  const perPage = Math.min(opts.perPage ?? 50, 200)
  const afterEpoch = opts.after ? Math.floor(opts.after.getTime() / 1000) : undefined
  const beforeEpoch = opts.before ? Math.floor(opts.before.getTime() / 1000) : undefined

  let page = 1
  let totalProcessed = 0
  let totalStored = 0
  let totalSkipped = 0
  const errors: string[] = []

  const { ingest } = await import('@locigram/pipeline')

  console.log(`[strava:backfill] Starting backfill...`)
  if (opts.after) console.log(`  after: ${opts.after.toISOString()}`)
  if (opts.before) console.log(`  before: ${opts.before.toISOString()}`)

  while (true) {
    console.log(`[strava:backfill] Fetching page ${page}...`)

    const activities = await getActivities({
      after: afterEpoch,
      before: beforeEpoch,
      page,
      perPage,
    })

    if (activities.length === 0) break

    for (const activity of activities) {
      try {
        let activityData = activity

        // Optionally fetch full detail (includes splits, laps)
        if (opts.detailed) {
          activityData = await getActivityDetail(activity.id)
          // Small delay between detail fetches to be nice to the API
          await new Promise(r => setTimeout(r, 500))
        }

        const memory = transformActivity(activityData)
        const result = await ingest([memory], opts.db, opts.pipelineConfig)

        totalStored += result.stored
        totalSkipped += result.skipped
        totalProcessed++

        if (result.stored > 0) {
          console.log(`  ✅ ${activity.start_date_local?.split('T')[0]} — ${activity.name} (${activity.type})`)
        } else {
          console.log(`  ⏭️ ${activity.start_date_local?.split('T')[0]} — ${activity.name} (already exists)`)
        }
      } catch (err: any) {
        const msg = `Activity ${activity.id} (${activity.name}): ${err.message}`
        console.error(`  ❌ ${msg}`)
        errors.push(msg)
      }
    }

    // If we got fewer than perPage, we've reached the end
    if (activities.length < perPage) break

    page++

    // Small delay between pages
    await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`[strava:backfill] Complete: ${totalProcessed} processed, ${totalStored} stored, ${totalSkipped} skipped, ${errors.length} errors`)

  return {
    total: totalProcessed,
    stored: totalStored,
    skipped: totalSkipped,
    errors,
  }
}
