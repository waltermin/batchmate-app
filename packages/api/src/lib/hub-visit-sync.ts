import type { Database } from "@batchmate/db"
import { hubVisitSync, jobCursor, presenceEvent } from "@batchmate/db/schema"
import { and, asc, eq, gt, lte, min, ne, sql } from "drizzle-orm"
import { hubDayFor, hubDayStart, nextHubDay } from "./date"
import {
	computeSettledIntervals,
	loadObservations,
	MAX_TTL_SECONDS,
	type SettledInterval,
} from "./presence"
import {
	HubVisitRateLimitError,
	type HubVisitWriter,
	pushHubVisit,
} from "./rc-hub-visits"

const EXPIRY_CURSOR = "presence-expiry"
const SEND_BATCH_SIZE = 50
const SEND_CONCURRENCY = 5
const RETRY_BASE_MS = 60_000
const RETRY_MAX_MS = 6 * 60 * 60 * 1000

export interface HubVisit {
	personId: number
	day: string
	visitedAt: Date
}

// One visit per hub day a person's settled presence touches, timed at their
// earliest presence that day (6am for presence carried over from the night
// before).
export function hubVisitsFromIntervals(
	intervals: SettledInterval[],
): Map<string, number> {
	const visits = new Map<string, number>()
	for (const interval of intervals) {
		const lastDay = hubDayFor(interval.last)
		for (let day = hubDayFor(interval.start); ; day = nextHubDay(day)) {
			const visitedAt = Math.max(interval.start, hubDayStart(day))
			const existing = visits.get(day)
			if (existing === undefined || visitedAt < existing) {
				visits.set(day, visitedAt)
			}
			if (day >= lastDay) break
		}
	}
	return visits
}

// Recomputes a person's hub visits from their presence around `from` and
// records any new day, or any earlier time for a known day. Returns the
// visits that now need sending to RC.
export async function recordHubVisitsForPerson(
	db: Database,
	personId: number,
	from: number,
	now: number,
): Promise<HubVisit[]> {
	const observations = await loadObservations(
		db,
		from,
		Math.max(from, now),
		personId,
	)
	const intervals = computeSettledIntervals(observations, now).get(personId)
	if (!intervals) return []

	const due: HubVisit[] = []
	for (const [day, visitedAt] of hubVisitsFromIntervals(intervals)) {
		const rows = await db
			.insert(hubVisitSync)
			.values({
				personId,
				day,
				visitedAt: new Date(visitedAt),
				nextAttemptAt: new Date(now),
			})
			.onConflictDoUpdate({
				target: [hubVisitSync.personId, hubVisitSync.day],
				set: {
					visitedAt: sql`excluded.visited_at`,
					status: "pending",
					attempts: 0,
					nextAttemptAt: sql`excluded.next_attempt_at`,
					lastError: null,
					updatedAt: new Date(now),
				},
				setWhere: sql`excluded.visited_at < ${hubVisitSync.visitedAt}`,
			})
			.returning({
				personId: hubVisitSync.personId,
				day: hubVisitSync.day,
				visitedAt: hubVisitSync.visitedAt,
			})
		due.push(...rows)
	}
	return due
}

// Sends visits to RC a few at a time. Failures retry with exponential
// backoff (1 minute doubling, capped at 6 hours). Each row's outcome is only recorded if
// its visitedAt hasn't moved since it was read, so a concurrent earlier time
// stays pending. Stops early if RC says to slow down.
export async function sendHubVisits(
	db: Database,
	visits: HubVisit[],
	writer: HubVisitWriter = pushHubVisit,
): Promise<{ sent: number; failed: number }> {
	let sent = 0
	let failed = 0
	for (let i = 0; i < visits.length; i += SEND_CONCURRENCY) {
		const chunk = visits.slice(i, i + SEND_CONCURRENCY)
		const results = await Promise.allSettled(
			chunk.map((v) => writer(v.personId, v.visitedAt)),
		)
		const now = Date.now()
		let rateLimited = false
		for (const [j, result] of results.entries()) {
			const visit = chunk[j]
			const sameVisit = and(
				eq(hubVisitSync.personId, visit.personId),
				eq(hubVisitSync.day, visit.day),
				eq(hubVisitSync.visitedAt, visit.visitedAt),
			)
			if (result.status === "fulfilled") {
				sent++
				await db
					.update(hubVisitSync)
					.set({ status: "synced", syncedAt: new Date(now), lastError: null })
					.where(sameVisit)
			} else {
				failed++
				rateLimited ||= result.reason instanceof HubVisitRateLimitError
				await db
					.update(hubVisitSync)
					.set({
						status: "failed",
						attempts: sql`${hubVisitSync.attempts} + 1`,
						nextAttemptAt: sql`${now} + min(${RETRY_BASE_MS} * (1 << ${hubVisitSync.attempts}), ${RETRY_MAX_MS})`,
						lastError: String(result.reason).slice(0, 500),
					})
					.where(sameVisit)
			}
		}
		if (rateLimited) break
	}
	return { sent, failed }
}

// The scheduled job. Settles presence whose TTL ran out since the last run
// (nothing else would notice it), then sends every visit that is due,
// including retries.
export async function runHubVisitSync(
	db: Database,
	options: { now?: number; writer?: HubVisitWriter } = {},
) {
	const now = options.now ?? Date.now()

	const cursor = await db
		.select({ at: jobCursor.at })
		.from(jobCursor)
		.where(eq(jobCursor.name, EXPIRY_CURSOR))
		.get()
	const since = cursor?.at ?? new Date(now - MAX_TTL_SECONDS * 1000)
	const expired = await db
		.select({
			personId: presenceEvent.personId,
			from: min(presenceEvent.timestamp),
		})
		.from(presenceEvent)
		.where(
			and(
				gt(presenceEvent.expiresAt, since),
				lte(presenceEvent.expiresAt, new Date(now)),
			),
		)
		.groupBy(presenceEvent.personId)
		.all()
	for (const { personId, from } of expired) {
		if (from) await recordHubVisitsForPerson(db, personId, from.getTime(), now)
	}
	await db
		.insert(jobCursor)
		.values({ name: EXPIRY_CURSOR, at: new Date(now) })
		.onConflictDoUpdate({ target: jobCursor.name, set: { at: new Date(now) } })

	const due = await db
		.select({
			personId: hubVisitSync.personId,
			day: hubVisitSync.day,
			visitedAt: hubVisitSync.visitedAt,
		})
		.from(hubVisitSync)
		.where(
			and(
				ne(hubVisitSync.status, "synced"),
				lte(hubVisitSync.nextAttemptAt, new Date(now)),
			),
		)
		.orderBy(asc(hubVisitSync.nextAttemptAt))
		.limit(SEND_BATCH_SIZE)
		.all()
	const result = await sendHubVisits(db, due, options.writer)
	return { expiredPeople: expired.length, ...result }
}
