-- Durable asset payloads for hosts without a persistent disk.
ALTER TABLE "Asset" ADD COLUMN "content" BYTEA;
