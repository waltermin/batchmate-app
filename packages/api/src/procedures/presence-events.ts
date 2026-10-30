import { presenceEvent } from "@batchmate/db/schema"
import { and, asc, eq, gt, gte, lte, or } from "drizzle-orm"
import { server } from "../context"
import {
	decodeEventCursor,
	encodeEventCursor,
	toEventDto,
} from "../lib/presence"
import { requireUser } from "../lib/snack-bar"

const DEFAULT_PAGE_SIZE = 100

export const presenceEvents = server.presenceEvents.handler(
	async ({ context, input }) => {
		requireUser(context)
		const limit = input.limit ?? DEFAULT_PAGE_SIZE

		const conditions = [
			gte(presenceEvent.timestamp, new Date(input.start)),
			lte(presenceEvent.timestamp, new Date(input.end)),
		]
		if (input.personId !== undefined) {
			conditions.push(eq(presenceEvent.personId, input.personId))
		}
		if (input.source !== undefined) {
			conditions.push(eq(presenceEvent.source, input.source))
		}
		if (input.cursor) {
			const cursor = decodeEventCursor(input.cursor)
			const after = or(
				gt(presenceEvent.timestamp, cursor.timestamp),
				and(
					eq(presenceEvent.timestamp, cursor.timestamp),
					gt(presenceEvent.id, cursor.id),
				),
			)
			if (after) conditions.push(after)
		}

		const rows = await context.db
			.select()
			.from(presenceEvent)
			.where(and(...conditions))
			.orderBy(asc(presenceEvent.timestamp), asc(presenceEvent.id))
			.limit(limit + 1)
			.all()

		const page = rows.slice(0, limit)
		return {
			events: page.map(toEventDto),
			nextCursor:
				rows.length > limit ? encodeEventCursor(page[page.length - 1]) : null,
		}
	},
)
