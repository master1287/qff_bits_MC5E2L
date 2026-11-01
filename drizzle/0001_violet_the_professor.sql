CREATE TABLE `quantum_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`backend` text NOT NULL,
	`intercept` integer NOT NULL,
	`created_at` text NOT NULL,
	`owner_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `quantum_jobs_owner_created_idx` ON `quantum_jobs` (`owner_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `security_plan` text;