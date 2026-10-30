import { describe, expect, it } from "vitest"
import {
	clipIntervals,
	computePresenceIntervals,
	intervalAt,
	type PresenceObservation,
} from "./presence"

// Times are in minutes for readability; events and results are in ms.
const MIN = 60_000
const LATER = 10_000 * MIN

let nextId = 0
function present(
	minute: number,
	ttlMinutes: number,
	opts: { personId?: number; source?: string } = {},
): PresenceObservation {
	return {
		id: `pev_${String(nextId++).padStart(26, "0")}`,
		personId: opts.personId ?? 1,
		source: opts.source ?? "a",
		present: true,
		ttlSeconds: ttlMinutes * 60,
		timestamp: minute * MIN,
	}
}
function absent(
	minute: number,
	opts: { personId?: number; source?: string } = {},
): PresenceObservation {
	return {
		...present(minute, 0, opts),
		present: false,
		ttlSeconds: null,
	}
}

// Results for one person, as [startMinute, endMinute] pairs.
function spans(events: PresenceObservation[], personId = 1, now = LATER) {
	return (computePresenceIntervals(events, now).get(personId) ?? []).map(
		(i) => [i.start / MIN, i.end / MIN],
	)
}

describe("computePresenceIntervals", () => {
	it("holds a present event for its TTL", () => {
		expect(spans([present(0, 10)])).toEqual([[0, 10]])
	})

	it("extends presence when a new present event lands before expiry", () => {
		expect(spans([present(0, 10), present(5, 10)])).toEqual([[0, 15]])
	})

	it("replaces the expiry even when the new TTL ends sooner", () => {
		expect(spans([present(0, 60), present(5, 1)])).toEqual([[0, 6]])
	})

	it("leaves a gap when presence expires before the next event", () => {
		expect(spans([present(0, 10), present(20, 10)])).toEqual([
			[0, 10],
			[20, 30],
		])
	})

	it("ends presence at an absent event", () => {
		expect(spans([present(0, 60), absent(15)])).toEqual([[0, 15]])
	})

	it("ignores repeated and leading absences", () => {
		expect(
			spans([absent(0), present(5, 60), absent(10), absent(20), absent(30)]),
		).toEqual([[5, 10]])
	})

	it("ignores an absence after presence already expired", () => {
		expect(spans([present(0, 10), absent(30)])).toEqual([[0, 10]])
	})

	it("keeps sources independent", () => {
		// Source b's absence must not cut short source a's presence.
		expect(
			spans([
				present(0, 60, { source: "a" }),
				present(10, 60, { source: "b" }),
				absent(20, { source: "b" }),
			]),
		).toEqual([[0, 60]])
	})

	it("unions overlapping and touching intervals across sources", () => {
		expect(
			spans([
				present(0, 10, { source: "a" }),
				present(10, 10, { source: "b" }),
				present(50, 10, { source: "a" }),
				present(55, 10, { source: "b" }),
			]),
		).toEqual([
			[0, 20],
			[50, 65],
		])
	})

	it("keeps people separate", () => {
		const events = [present(0, 10, { personId: 1 }), absent(5, { personId: 2 })]
		expect(spans(events, 1)).toEqual([[0, 10]])
		expect(spans(events, 2)).toEqual([])
	})

	it("orders events by timestamp regardless of input order", () => {
		expect(spans([absent(15), present(0, 60)])).toEqual([[0, 15]])
	})

	it("breaks timestamp ties by id", () => {
		const first = present(0, 60)
		const second = absent(0)
		expect(spans([second, first])).toEqual([])
	})

	it("marks intervals covering now as ongoing", () => {
		const [interval] =
			computePresenceIntervals([present(0, 60)], 30 * MIN).get(1) ?? []
		expect(interval.ongoing).toBe(true)
		const [past] =
			computePresenceIntervals([present(0, 60)], LATER).get(1) ?? []
		expect(past.ongoing).toBe(false)
	})
})

describe("clipIntervals", () => {
	it("trims intervals to the range and drops ones outside it", () => {
		const intervals = computePresenceIntervals(
			[present(0, 30), present(100, 10), present(200, 10)],
			LATER,
		).get(1)
		expect(
			clipIntervals(intervals ?? [], 20 * MIN, 105 * MIN).map((i) => [
				i.start / MIN,
				i.end / MIN,
			]),
		).toEqual([
			[20, 30],
			[100, 105],
		])
	})

	it("counts a presence from before the range that is still in effect", () => {
		// The lookback window: an event 23h before the range still covers it.
		const intervals = computePresenceIntervals(
			[present(0, 24 * 60)],
			LATER,
		).get(1)
		expect(
			clipIntervals(intervals ?? [], 23 * 60 * MIN, 25 * 60 * MIN),
		).toEqual([{ start: 23 * 60 * MIN, end: 24 * 60 * MIN, ongoing: false }])
	})
})

describe("intervalAt", () => {
	const intervals =
		computePresenceIntervals([present(0, 10)], LATER).get(1) ?? []

	it("includes the start and excludes the end", () => {
		expect(intervalAt(intervals, 0)).toBeDefined()
		expect(intervalAt(intervals, 9 * MIN)).toBeDefined()
		expect(intervalAt(intervals, 10 * MIN)).toBeUndefined()
	})
})
