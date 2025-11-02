-- AlterTable
ALTER TABLE "EventLog" ADD COLUMN "message" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessCode" (
    "level" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AccessCode" ("code", "level", "updatedAt") SELECT "code", "level", "updatedAt" FROM "AccessCode";
DROP TABLE "AccessCode";
ALTER TABLE "new_AccessCode" RENAME TO "AccessCode";
CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
