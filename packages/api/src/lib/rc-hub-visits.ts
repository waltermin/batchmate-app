// Records a hub visit on RC for any person at a given time.
//
// STUB: RC's API only lets a person write their own visits (with their own
// OAuth token, by date). This stands in for an endpoint that takes a service
// credential and an exact time, so the sync pipeline can be built and tested
// first. It logs instead of calling RC; replace the body once that endpoint
// exists. Throw HubVisitRateLimitError on a 429 so callers back off.
export async function pushHubVisit(
	personId: number,
	visitedAt: Date,
): Promise<void> {
	console.log(
		`[hub-visit-sync] stub: would record hub visit for person ${personId} at ${visitedAt.toISOString()}`,
	)
}

export type HubVisitWriter = typeof pushHubVisit

export class HubVisitRateLimitError extends Error {}
