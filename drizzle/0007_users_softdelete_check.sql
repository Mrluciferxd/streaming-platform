-- A soft-deleted user has its PII (email, phone, passwordHash, avatarUrl)
-- nulled to honour a DPDP Act 2023 erasure request, while the row stays for
-- referential integrity (watch history, audit actor). The original
-- `users_identifier_present` check required email OR phone to be non-null,
-- which made the soft-delete UPDATE trip the check the moment both were
-- nulled. Replace it with a version that only applies to live rows.
ALTER TABLE "public"."users" DROP CONSTRAINT "users_identifier_present";--> statement-breakpoint
ALTER TABLE "public"."users" ADD CONSTRAINT "users_identifier_present"
  CHECK (("email" is not null or "phone" is not null) or "deleted_at" is not null);--> statement-breakpoint
