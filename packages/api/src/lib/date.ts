// Hub days follow RC's local calendar, not the worker's (UTC) clock.
export function todayInNY(): string {
	return new Date().toLocaleDateString("en-CA", {
		timeZone: "America/New_York",
	})
}

const NY_TIME_ZONE = "America/New_York"
const HUB_DAY_START_HOUR = 6
const DAY_MS = 24 * 60 * 60 * 1000

const nyParts = new Intl.DateTimeFormat("en-US", {
	timeZone: NY_TIME_ZONE,
	hourCycle: "h23",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
})

// New York wall-clock time for an instant, as if it were UTC.
function nyWallClock(ms: number): number {
	const parts = Object.fromEntries(
		nyParts.formatToParts(ms).map((p) => [p.type, Number(p.value)]),
	)
	return Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	)
}

// The hub day (YYYY-MM-DD) an instant belongs to. Hub days run 6am to 6am
// New York time. This works on the wall clock rather than subtracting six
// hours from UTC, because DST shifts happen at 2am, inside that window.
export function hubDayFor(ms: number): string {
	const wall = nyWallClock(ms)
	const shifted = wall - HUB_DAY_START_HOUR * 60 * 60 * 1000
	return new Date(shifted).toISOString().slice(0, 10)
}

// The instant a hub day starts: 6:00am New York time on that date.
export function hubDayStart(day: string): number {
	const wall = Date.parse(`${day}T0${HUB_DAY_START_HOUR}:00:00Z`)
	// Correct the UTC guess by New York's offset at that moment. 6am is never
	// inside a DST transition, so one correction lands exactly.
	const guess = wall + (wall - nyWallClock(wall))
	return guess + (wall - nyWallClock(guess))
}

export function nextHubDay(day: string): string {
	return new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10)
}
