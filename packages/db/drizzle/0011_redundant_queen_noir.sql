CREATE TABLE `hub_visit_sync` (
	`person_id` integer NOT NULL,
	`day` text NOT NULL,
	`visited_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`synced_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`person_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `hub_visit_sync_due_idx` ON `hub_visit_sync` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `job_cursor` (
	`name` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `presence_event` ADD `expires_at` integer;--> statement-breakpoint
CREATE INDEX `presence_event_expires_at_idx` ON `presence_event` (`expires_at`);--> statement-breakpoint
UPDATE `presence_event` SET `expires_at` = `timestamp` + `ttl_seconds` * 1000 WHERE `present` = 1;