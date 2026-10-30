import { server } from "../context"
import {
	computePresenceIntervals,
	intervalAt,
	loadObservations,
} from "../lib/presence"
import { requireUser } from "../lib/snack-bar"

const LOOKAHEAD_MS = 31 * 24 * 60 * 60 * 1000

export const presenceAt = server.presenceAt.handler(
	async ({ context, input }) => {
		requireUser(context)
		const now = Date.now()
		const at = input.at ? Date.parse(input.at) : now

		// Read past `at` too, so a historical query sees when that presence
		// actually ended rather than when it was due to expire.
		const until = Math.max(at, Math.min(now, at + LOOKAHEAD_MS))
		const observations = await loadObservations(context.db, at, until)
		const byPerson = computePresenceIntervals(observations, now)

		const people = []
		for (const [personId, intervals] of byPerson) {
			const interval = intervalAt(intervals, at)
			if (!interval) continue
			people.push({
				personId,
				since: new Date(interval.start).toISOString(),
				until: new Date(interval.end).toISOString(),
			})
		}
		people.sort((a, b) => a.personId - b.personId)
		return { at: new Date(at).toISOString(), people }
	},
)
