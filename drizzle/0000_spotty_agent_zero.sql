CREATE TABLE `exchanges` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`wrapped_key` text,
	`transcript` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exchanges_room_idx` ON `exchanges` (`room_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`exchange_id` text NOT NULL,
	`role` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`exchange_id`) REFERENCES `exchanges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_room_created_idx` ON `messages` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`alice_hash` text NOT NULL,
	`bob_hash` text,
	`invite_hash` text,
	`alice_name` text NOT NULL,
	`bob_name` text,
	`created_at` text NOT NULL,
	`active_exchange` text,
	`latest_attempt` text,
	`last_send` integer DEFAULT 0 NOT NULL,
	`last_exchange` integer DEFAULT 0 NOT NULL,
	`last_invite` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_invite_hash_unique` ON `rooms` (`invite_hash`);