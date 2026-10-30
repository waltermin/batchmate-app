import { type Database, parseTypeId } from "@batchmate/db"
import { presenceEvent } from "@batchmate/db/schema"
import { ORPCError } from "@orpc/server"
import { and, asc, eq, gte, lte } from "drizzle-orm"

// Upper bound on a present event's TTL. Also how far before a range we have
// to look: an event older than this can't still be in effect at its start.
export const MAX_TTL_SECONDS = 86_400

export interface PresenceObservation {
	id: string
	personId: number
	source: string
	present: boolean
	ttlSeconds: number | null
	timestamp: number
}

export interface PresenceInterval {
	start: number
	// Exclusive. For an ongoing interval, when it expires unless renewed.
	end: number
	// Still in effect as of `now`.
	ongoing: boolean
}

// Turns raw events into each person's presence intervals, unclipped and
// sorted by start. Each (person, source) pair is tracked separately: a
// present event holds until its TTL runs out, a later present event replaces
// that expiry with its own, and an absent event ends it immediately. A person
// is present whenever any of their sources says so.
export function computePresenceIntervals(
	events: PresenceObservation[],
	now: number,
): Map<number, PresenceInterval[]> {
	const sorted = [...events].sort(
		(a, b) =>
			a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	)

	const open = new Map<
		string,
		{ personId: number; start: number; expiresAt: number }
	>()
	const byPerson = new Map<number, { start: number; end: number }[]>()
	const close = (personId: number, start: number, end: number) => {
		if (end <= start) return
		const intervals = byPerson.get(personId) ?? []
		intervals.push({ start, end })
		byPerson.set(personId, intervals)
	}

	for (const event of sorted) {
		const key = `${event.personId}:${event.source}`
		let current = open.get(key)
		if (current && current.expiresAt <= event.timestamp) {
			close(current.personId, current.start, current.expiresAt)
			open.delete(key)
			current = undefined
		}

		if (event.present) {
			const expiresAt = event.timestamp + (event.ttlSeconds ?? 0) * 1000
			if (current) {
				current.expiresAt = expiresAt
			} else {
				open.set(key, {
					personId: event.personId,
					start: event.timestamp,
					expiresAt,
				})
			}
		} else if (current) {
			close(current.personId, current.start, event.timestamp)
			open.delete(key)
		}
	}
	for (const current of open.values()) {
		close(current.personId, current.start, current.expiresAt)
	}

	const result = new Map<number, PresenceInterval[]>()
	for (const [personId, intervals] of byPerson) {
		intervals.sort((a, b) => a.start - b.start)
		const merged: { start: number; end: number }[] = []
		for (const interval of intervals) {
			const last = merged[merged.length - 1]
			if (last && interval.start <= last.end) {
				last.end = Math.max(last.end, interval.end)
			} else {
				merged.push({ ...interval })
			}
		}
		result.set(
			personId,
			merged.map((m) => ({ ...m, ongoing: m.start <= now && m.end > now })),
		)
	}
	return result
}

export interface SettledInterval {
	start: number
	// Inclusive: the last instant known for certain to be present.
	last: number
}

// Presence that no later event can take back, merged per person and sorted.
// Runs the same per-(person, source) walk as computePresenceIntervals, but
// an interval that is still open only counts up to its latest present event:
// the TTL beyond that is a projection an absent event could still cut short.
// Everything else (ended by an absent, or expired by `now`) counts in full.
export function computeSettledIntervals(
	events: PresenceObservation[],
	now: number,
): Map<number, SettledInterval[]> {
	const sorted = [...events].sort(
		(a, b) =>
			a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	)

	const open = new Map<
		string,
		{ personId: number; start: number; expiresAt: number; lastSeen: number }
	>()
	const byPerson = new Map<number, SettledInterval[]>()
	const settle = (personId: number, start: number, last: number) => {
		const intervals = byPerson.get(personId) ?? []
		intervals.push({ start, last: Math.max(start, last) })
		byPerson.set(personId, intervals)
	}

	for (const event of sorted) {
		const key = `${event.personId}:${event.source}`
		let current = open.get(key)
		if (current && current.expiresAt <= event.timestamp) {
			settle(current.personId, current.start, current.expiresAt - 1)
			open.delete(key)
			current = undefined
		}

		if (event.present) {
			const expiresAt = event.timestamp + (event.ttlSeconds ?? 0) * 1000
			if (current) {
				current.expiresAt = expiresAt
				current.lastSeen = event.timestamp
			} else {
				open.set(key, {
					personId: event.personId,
					start: event.timestamp,
					expiresAt,
					lastSeen: event.timestamp,
				})
			}
		} else if (current) {
			settle(current.personId, current.start, event.timestamp - 1)
			open.delete(key)
		}
	}
	for (const current of open.values()) {
		const last =
			current.expiresAt <= now ? current.expiresAt - 1 : current.lastSeen
		settle(current.personId, current.start, last)
	}

	for (const [personId, intervals] of byPerson) {
		intervals.sort((a, b) => a.start - b.start)
		const merged: SettledInterval[] = []
		for (const interval of intervals) {
			const prev = merged[merged.length - 1]
			if (prev && interval.start <= prev.last + 1) {
				prev.last = Math.max(prev.last, interval.last)
			} else {
				merged.push({ ...interval })
			}
		}
		byPerson.set(personId, merged)
	}
	return byPerson
}

// Intervals overlapping [start, end), clipped to it.
export function clipIntervals(
	intervals: PresenceInterval[],
	start: number,
	end: number,
): PresenceInterval[] {
	return intervals
		.filter((i) => i.start < end && i.end > start)
		.map((i) => ({
			start: Math.max(i.start, start),
			end: Math.min(i.end, end),
			ongoing: i.ongoing,
		}))
}

// The interval containing `at`, if any.
export function intervalAt(
	intervals: PresenceInterval[],
	at: number,
): PresenceInterval | undefined {
	return intervals.find((i) => i.start <= at && at < i.end)
}

// Every event that can affect presence within [start, end].
export async function loadObservations(
	db: Database,
	start: number,
	end: number,
	personId?: number,
): Promise<PresenceObservation[]> {
	const conditions = [
		gte(presenceEvent.timestamp, new Date(start - MAX_TTL_SECONDS * 1000)),
		lte(presenceEvent.timestamp, new Date(end)),
	]
	if (personId !== undefined) {
		conditions.push(eq(presenceEvent.personId, personId))
	}
	const rows = await db
		.select({
			id: presenceEvent.id,
			personId: presenceEvent.personId,
			source: presenceEvent.source,
			present: presenceEvent.present,
			ttlSeconds: presenceEvent.ttlSeconds,
			timestamp: presenceEvent.timestamp,
		})
		.from(presenceEvent)
		.where(and(...conditions))
		.orderBy(asc(presenceEvent.timestamp), asc(presenceEvent.id))
		.all()
	return rows.map((row) => ({
		...row,
		id: String(row.id),
		timestamp: row.timestamp.getTime(),
	}))
}

// Events page in (timestamp, id) order, so the cursor carries both.
export function encodeEventCursor(row: { id: unknown; timestamp: Date }) {
	return `${row.timestamp.getTime()}:${String(row.id)}`
}

export function decodeEventCursor(cursor: string) {
	const [ms, id] = cursor.split(":")
	try {
		const timestamp = Number(ms)
		if (!Number.isSafeInteger(timestamp)) throw new Error()
		return { timestamp: new Date(timestamp), id: parseTypeId(id, "pev") }
	} catch {
		throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor" })
	}
}

export function toEventDto(row: typeof presenceEvent.$inferSelect) {
	return {
		id: String(row.id),
		personId: row.personId,
		source: row.source,
		present: row.present,
		ttlSeconds: row.ttlSeconds,
		data: row.data ?? null,
		timestamp: row.timestamp.toISOString(),
		createdAt: row.createdAt.toISOString(),
	}
}
