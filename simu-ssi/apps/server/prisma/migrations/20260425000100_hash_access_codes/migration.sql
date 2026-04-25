-- Replace plaintext access codes with hashed access codes.
-- Existing plaintext values are intentionally not migrated into codeHash because SQLite cannot safely derive
-- the application scrypt hashes during migration. Administrators must reset access codes after this migration.

CREATE TABLE "new_AccessCode" (
  "level" INTEGER NOT NULL PRIMARY KEY,
  "codeHash" TEXT,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_AccessCode" ("level", "codeHash", "updatedAt")
SELECT "level", NULL, CURRENT_TIMESTAMP FROM "AccessCode";

DROP TABLE "AccessCode";
ALTER TABLE "new_AccessCode" RENAME TO "AccessCode";
