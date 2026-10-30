import { server } from "../context"
import {
	clipIntervals,
	computePresenceIntervals,
	loadObservations,
} from "../lib/presence"
import { requireUser } from "../lib/snack-bar"

export const presenceTimeline = server.presenceTimeline.handler(
	async ({ context, input }) => {
		requireUser(context)
		const start = Date.parse(input.start)
		const end = Date.parse(input.end)

		const observations = await loadObservations(
			context.db,
			start,
			end,
			input.personId,
		)
		const byPerson = computePresenceIntervals(observations, Date.now())

		const people = []
		for (const [personId, intervals] of byPerson) {
			const clipped = clipIntervals(intervals, start, end)
			if (clipped.length === 0) continue
			people.push({
				personId,
				intervals: clipped.map((i) => ({
					start: new Date(i.start).toISOString(),
					end: new Date(i.end).toISOString(),
					ongoing: i.ongoing,
				})),
			})
		}
		people.sort((a, b) => a.personId - b.personId)
		return { people }
	},
)
