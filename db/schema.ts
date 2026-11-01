import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(), name: text("name").notNull(),
  aliceHash: text("alice_hash").notNull(), bobHash: text("bob_hash"), inviteHash: text("invite_hash"),
  aliceName: text("alice_name").notNull(), bobName: text("bob_name"), createdAt: text("created_at").notNull(),
  activeExchange: text("active_exchange"), latestAttempt: text("latest_attempt"),
  securityPlan: text("security_plan"),
  lastSend: integer("last_send").notNull().default(0), lastExchange: integer("last_exchange").notNull().default(0),
  lastInvite: integer("last_invite").notNull().default(0),
}, (table) => [uniqueIndex("rooms_invite_hash_unique").on(table.inviteHash)]);

export const exchanges = sqliteTable("exchanges", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull().references(() => rooms.id),
  wrappedKey: text("wrapped_key"), transcript: text("transcript").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("exchanges_room_idx").on(table.roomId)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull().references(() => rooms.id),
  exchangeId: text("exchange_id").notNull().references(() => exchanges.id),
  role: text("role", { enum: ["alice", "bob"] }).notNull(), ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [index("messages_room_created_idx").on(table.roomId, table.createdAt)]);

export const quantumJobs = sqliteTable("quantum_jobs", {
  id: text("id").primaryKey(), backend: text("backend").notNull(),
  intercept: integer("intercept").notNull(), createdAt: text("created_at").notNull(),
  ownerId: text("owner_id").notNull(), status: text("status").notNull().default("queued"),
  result: text("result"),
}, table => [index("quantum_jobs_owner_created_idx").on(table.ownerId, table.createdAt)]);

export const ownerLoginAttempts = sqliteTable("owner_login_attempts", {
  id: text("id").primaryKey(), attempts: integer("attempts").notNull(), resetAt: integer("reset_at").notNull(),
});
