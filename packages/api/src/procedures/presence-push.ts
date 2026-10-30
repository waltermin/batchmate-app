import { presenceEvent } from "@batchmate/db/schema"
import { ORPCError } from "@orpc/server"
import { server } from "../context"
import { recordHubVisitsForPerson, sendHubVisits } from "../lib/hub-visit-sync"
import { toEventDto } from "../lib/presence"
import { requireUser } from "../lib/snack-bar"

// Tolerates clock drift on the reporting side.
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

export const presencePush = server.presencePush.handler(
	async ({ context, input }) => {
		requireUser(context)

		const now = Date.now()
		const timestamp = input.timestamp ? Date.parse(input.timestamp) : now
		if (timestamp > now + MAX_FUTURE_SKEW_MS) {
			throw new ORPCError("BAD_REQUEST", {
				message: "timestamp is in the future",
			})
		}

		const row = await context.db
			.insert(presenceEvent)
			.values({
				personId: input.personId,
				source: input.source,
				present: input.present,
				ttlSeconds: input.present ? input.ttlSeconds : null,
				expiresAt: input.present
					? new Date(timestamp + input.ttlSeconds * 1000)
					: null,
				data: input.data ?? null,
				timestamp: new Date(timestamp),
			})
			.returning()
			.get()

		// Any event can settle presence (a present confirms the time since the
		// last one, an absent closes it), so recompute this person's hub visits
		// now and send new ones without holding up the response. Rows are
		// recorded first, so the scheduled job retries anything that fails.
		const due = await recordHubVisitsForPerson(
			context.db,
			input.personId,
			timestamp,
			now,
		)
		if (due.length > 0) {
			context.waitUntil(sendHubVisits(context.db, due))
		}

		return toEventDto(row)
	},
)
