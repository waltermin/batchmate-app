import { sql } from "drizzle-orm"
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core"
import { user } from "./auth-schema"
import { typeIdColumn, typeIdPrimaryKey } from "./typeid"

export * from "./auth-schema"

export const recurseProfile = sqliteTable("recurse_profile", {
	personId: integer("person_id").primaryKey(),
	imageUrl: text("image_url"),
	batch: text("batch"),
	stintType: text("stint_type"),
	stintInProgress: integer("stint_in_progress", { mode: "boolean" }),
	pronouns: text("pronouns"),
	cachedAt: integer("cached_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
})

export const zoomRoom = sqliteTable("zoom_room", {
	slug: text("slug").primaryKey(),
	label: text("label").notNull(),
	directUrl: text("direct_url").notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
})

export const snackSku = sqliteTable("snack_sku", {
	id: typeIdPrimaryKey("sku")("id"),
	name: text("name").notNull(),
	priceCents: integer("price_cents").notNull(),
	archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => new Date())
		.notNull(),
})

// The Snack Bar ledger. Append-only: entries are voided, never deleted.
// amountCents is positive for what the user owes (purchases) and negative
// for what they've paid back, so a balance is SUM(amount_cents) over
// non-voided rows.
export const snackLedgerEntry = sqliteTable(
	"snack_ledger_entry",
	{
		id: typeIdPrimaryKey("sle")("id"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id),
		kind: text("kind", { enum: ["purchase", "payment"] }).notNull(),
		skuId: typeIdColumn("sku")("sku_id").references(() => snackSku.id),
		// Snapshot of the SKU name at purchase time; prices live in amountCents.
		skuName: text("sku_name"),
		// Purchases only ("Buy another" bumps it). amountCents is always
		// quantity × the unit price at purchase time.
		quantity: integer("quantity").notNull().default(1),
		amountCents: integer("amount_cents").notNull(),
		source: text("source", { enum: ["nfc", "web", "admin"] }).notNull(),
		note: text("note"),
		// Payments only: who the money was handed or sent to.
		paymentRecipient: text("payment_recipient"),
		// Client-generated so a retried tap never records a second purchase.
		idempotencyKey: text("idempotency_key").unique(),
		recordedBy: text("recorded_by").references(() => user.id),
		voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
		voidedBy: text("voided_by").references(() => user.id),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("snack_ledger_entry_user_id_idx").on(table.userId, table.createdAt),
		index("snack_ledger_entry_created_at_idx").on(table.createdAt),
	],
)

// Presence observations from any source (an app, a sensor, a manual
// check-in). Append-only; a person's actual presence is computed at read
// time by merging these (see packages/api/src/lib/presence.ts).
export const presenceEvent = sqliteTable(
	"presence_event",
	{
		id: typeIdPrimaryKey("pev")("id"),
		// RC person id, not a batchmate user id: sources may observe people
		// who have never signed in here.
		personId: integer("person_id").notNull(),
		// Identifies the reporting app (e.g. "valet") so sources never
		// override each other's state.
		source: text("source").notNull(),
		present: integer("present", { mode: "boolean" }).notNull(),
		// Present events only: how long the observation holds unless an
		// absent event from the same source ends it sooner.
		ttlSeconds: integer("ttl_seconds"),
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
		// When the observation happened; createdAt is when we received it.
		timestamp: integer("timestamp", { mode: "timestamp_ms" }).notNull(),
		// Present events only: timestamp + ttl. Indexed so the expiry sweep can
		// find presence that ran out without any further event arriving.
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		index("presence_event_timestamp_idx").on(table.timestamp),
		index("presence_event_person_id_idx").on(table.personId, table.timestamp),
		index("presence_event_expires_at_idx").on(table.expiresAt),
		check(
			"presence_event_ttl_check",
			sql`(${table.present} = 1 AND ${table.ttlSeconds} BETWEEN 1 AND 86400) OR (${table.present} = 0 AND ${table.ttlSeconds} IS NULL)`,
		),
	],
)

// Hub visits owed to RC's hub visits API, derived from presence. One row per
// person per hub day (6am-6am New York) caps RC writes at one per person per
// day, however often presence events arrive. visitedAt only ever moves
// earlier; when it does, the row goes back to pending and is re-sent.
export const hubVisitSync = sqliteTable(
	"hub_visit_sync",
	{
		personId: integer("person_id").notNull(),
		day: text("day").notNull(),
		// Earliest settled presence that day (6am if it rolled over).
		visitedAt: integer("visited_at", { mode: "timestamp_ms" }).notNull(),
		status: text("status", { enum: ["pending", "synced", "failed"] })
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at", {
			mode: "timestamp_ms",
		}).notNull(),
		lastError: text("last_error"),
		syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.personId, table.day] }),
		index("hub_visit_sync_due_idx").on(table.status, table.nextAttemptAt),
	],
)

// Progress markers for scheduled jobs, keyed by job name.
export const jobCursor = sqliteTable("job_cursor", {
	name: text("name").primaryKey(),
	at: integer("at", { mode: "timestamp_ms" }).notNull(),
})
