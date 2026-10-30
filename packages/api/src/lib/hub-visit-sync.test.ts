import { describe, expect, it } from "vitest"
import { hubDayFor, hubDayStart, nextHubDay } from "./date"
import { hubVisitsFromIntervals } from "./hub-visit-sync"
import { computeSettledIntervals, type PresenceObservation } from "./presence"

const HOUR = 60 * 60

// Fri 2026-10-30 and nearby days are in EDT (UTC-4).
const at = (iso: string) => Date.parse(iso)

let nextId = 0
function present(
	iso: string,
	ttlSeconds: number,
	source = "a",
): PresenceObservation {
	return {
		id: `pev_${String(nextId++).padStart(26, "0")}`,
		personId: 1,
		source,
		present: true,
		ttlSeconds,
		timestamp: at(iso),
	}
}
function absent(iso: string, source = "a"): PresenceObservation {
	return { ...present(iso, 0, source), present: false, ttlSeconds: null }
}

// The visits owed for person 1, as { day: visitedAt ISO }.
function visits(events: PresenceObservation[], nowIso: string) {
	const intervals = computeSettledIntervals(events, at(nowIso)).get(1) ?? []
	return Object.fromEntries(
		[...hubVisitsFromIntervals(intervals)].map(([day, ms]) => [
			day,
			new Date(ms).toISOString(),
		]),
	)
}

describe("hub days", () => {
	it("start at 6am New York time", () => {
		expect(hubDayFor(at("2026-10-31T05:59:59-04:00"))).toBe("2026-10-30")
		expect(hubDayFor(at("2026-10-31T06:00:00-04:00"))).toBe("2026-10-31")
		expect(hubDayStart("2026-10-30")).toBe(at("2026-10-30T06:00:00-04:00"))
	})

	it("handle the night clocks go back", () => {
		expect(hubDayFor(at("2026-11-01T05:59:59-05:00"))).toBe("2026-10-31")
		expect(hubDayFor(at("2026-11-01T06:00:00-05:00"))).toBe("2026-11-01")
		expect(hubDayStart("2026-11-01")).toBe(at("2026-11-01T06:00:00-05:00"))
	})

	it("handle the night clocks go forward", () => {
		// Subtracting six hours from UTC would put this on the 13th.
		expect(hubDayFor(at("2027-03-14T06:30:00-04:00"))).toBe("2027-03-14")
		expect(hubDayFor(at("2027-03-14T05:59:59-04:00"))).toBe("2027-03-13")
		expect(hubDayStart("2027-03-14")).toBe(at("2027-03-14T06:00:00-04:00"))
	})

	it("step across month ends", () => {
		expect(nextHubDay("2026-10-31")).toBe("2026-11-01")
	})
})

describe("hub visits from presence", () => {
	it("credits the day of a single sighting right away", () => {
		expect(
			visits(
				[present("2026-10-30T21:00:00-04:00", 12 * HOUR)],
				"2026-10-30T21:05:00-04:00",
			),
		).toEqual({ "2026-10-30": "2026-10-31T01:00:00.000Z" })
	})

	it("credits the next day when an absent past 6am settles the overnight block", () => {
		expect(
			visits(
				[
					present("2026-10-30T21:00:00-04:00", 12 * HOUR),
					absent("2026-10-31T07:00:00-04:00"),
				],
				"2026-10-31T07:05:00-04:00",
			),
		).toEqual({
			"2026-10-30": "2026-10-31T01:00:00.000Z",
			"2026-10-31": "2026-10-31T10:00:00.000Z", // 6am EDT
		})
	})

	it("does not credit the next day for an absent at exactly 6am", () => {
		expect(
			visits(
				[
					present("2026-10-30T21:00:00-04:00", 12 * HOUR),
					absent("2026-10-31T06:00:00-04:00"),
				],
				"2026-10-31T07:00:00-04:00",
			),
		).toEqual({ "2026-10-30": "2026-10-31T01:00:00.000Z" })
	})

	it("waits for a TTL that crosses 6am to expire before crediting the next day", () => {
		const events = [present("2026-10-30T21:00:00-04:00", 12 * HOUR)]
		// Still within the TTL: an absent could yet arrive before 6am counts.
		expect(visits(events, "2026-10-31T08:00:00-04:00")).toEqual({
			"2026-10-30": "2026-10-31T01:00:00.000Z",
		})
		// Expired at 9am: the block through 9am is final.
		expect(visits(events, "2026-10-31T09:00:00-04:00")).toEqual({
			"2026-10-30": "2026-10-31T01:00:00.000Z",
			"2026-10-31": "2026-10-31T10:00:00.000Z",
		})
	})

	it("credits every day a long TTL covers once it expires", () => {
		const events = [present("2026-10-19T12:00:00-04:00", 72 * HOUR)]
		expect(visits(events, "2026-10-22T12:00:00-04:00")).toEqual({
			"2026-10-19": "2026-10-19T16:00:00.000Z",
			"2026-10-20": "2026-10-20T10:00:00.000Z",
			"2026-10-21": "2026-10-21T10:00:00.000Z",
			"2026-10-22": "2026-10-22T10:00:00.000Z",
		})
	})

	it("locks in the days before a new sighting during a long TTL", () => {
		const events = [
			present("2026-10-19T12:00:00-04:00", 72 * HOUR),
			present("2026-10-21T10:00:00-04:00", HOUR),
		]
		expect(visits(events, "2026-10-21T10:30:00-04:00")).toEqual({
			"2026-10-19": "2026-10-19T16:00:00.000Z",
			"2026-10-20": "2026-10-20T10:00:00.000Z",
			"2026-10-21": "2026-10-21T10:00:00.000Z",
		})
	})

	it("times a day at its earliest presence", () => {
		const events = [
			present("2026-10-30T14:00:00-04:00", HOUR),
			present("2026-10-30T10:00:00-04:00", HOUR),
		]
		expect(visits(events, "2026-10-30T20:00:00-04:00")).toEqual({
			"2026-10-30": "2026-10-30T14:00:00.000Z",
		})
	})

	it("keeps one source's absence from cutting short another's presence", () => {
		const events = [
			present("2026-10-30T21:00:00-04:00", 12 * HOUR, "a"),
			present("2026-10-30T22:00:00-04:00", 12 * HOUR, "b"),
			absent("2026-10-30T23:00:00-04:00", "b"),
			absent("2026-10-31T08:00:00-04:00", "a"),
		]
		expect(visits(events, "2026-10-31T09:00:00-04:00")).toEqual({
			"2026-10-30": "2026-10-31T01:00:00.000Z",
			"2026-10-31": "2026-10-31T10:00:00.000Z",
		})
	})

	it("credits nothing for absences alone", () => {
		expect(
			visits(
				[absent("2026-10-30T21:00:00-04:00")],
				"2026-10-31T09:00:00-04:00",
			),
		).toEqual({})
	})
})
