CREATE TABLE "AccessCode" (
  "level" INTEGER NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");

INSERT INTO "AccessCode" ("level", "code") VALUES (2, '2222')
  ON CONFLICT("level") DO UPDATE SET "code" = excluded."code", "updatedAt" = CURRENT_TIMESTAMP;
INSERT INTO "AccessCode" ("level", "code") VALUES (3, '3333')
  ON CONFLICT("level") DO UPDATE SET "code" = excluded."code", "updatedAt" = CURRENT_TIMESTAMP;
