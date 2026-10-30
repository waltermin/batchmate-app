CREATE TABLE `presence_event` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` integer NOT NULL,
	`source` text NOT NULL,
	`present` integer NOT NULL,
	`ttl_seconds` integer,
	`data` text,
	`timestamp` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	CONSTRAINT "presence_event_ttl_check" CHECK(("presence_event"."present" = 1 AND "presence_event"."ttl_seconds" BETWEEN 1 AND 86400) OR ("presence_event"."present" = 0 AND "presence_event"."ttl_seconds" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `presence_event_timestamp_idx` ON `presence_event` (`timestamp`);--> statement-breakpoint
CREATE INDEX `presence_event_person_id_idx` ON `presence_event` (`person_id`,`timestamp`);