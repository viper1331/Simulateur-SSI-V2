/*
  Warnings:

  - Added the required column `name` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'TRAINEE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessCode" (
    "level" INTEGER NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AccessCode" ("code", "level", "updatedAt") SELECT "code", "level", "updatedAt" FROM "AccessCode";
DROP TABLE "AccessCode";
ALTER TABLE "new_AccessCode" RENAME TO "AccessCode";
CREATE UNIQUE INDEX "AccessCode_code_key" ON "AccessCode"("code");
CREATE TABLE "new_EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,
    "source" TEXT NOT NULL,
    "zoneId" TEXT,
    "payloadJson" TEXT,
    CONSTRAINT "EventLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EventLog" ("id", "payloadJson", "sessionId", "source", "ts", "zoneId") SELECT "id", "payloadJson", "sessionId", "source", "ts", "zoneId" FROM "EventLog";
DROP TABLE "EventLog";
ALTER TABLE "new_EventLog" RENAME TO "EventLog";
CREATE TABLE "new_Score" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "rubricJson" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "comments" TEXT,
    CONSTRAINT "Score_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Score_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Score" ("comments", "id", "rubricJson", "sessionId", "userId", "value") SELECT "comments", "id", "rubricJson", "sessionId", "userId", "value" FROM "Score";
DROP TABLE "Score";
ALTER TABLE "new_Score" RENAME TO "Score";
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'libre',
    "objective" TEXT,
    "notes" TEXT,
    "improvementJson" TEXT,
    "trainerId" TEXT,
    "traineeId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "Session_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Session_traineeId_fkey" FOREIGN KEY ("traineeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Session" ("id", "name", "mode", "objective", "notes", "improvementJson", "trainerId", "traineeId", "startedAt", "endedAt")
SELECT "id", 'Session importée', "mode", NULL, NULL, NULL, "trainerId", NULL, "startedAt", "endedAt" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
CREATE TABLE "new_TraineeLayout" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "configJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_TraineeLayout" ("configJson", "id", "updatedAt") SELECT "configJson", "id", "updatedAt" FROM "TraineeLayout";
DROP TABLE "TraineeLayout";
ALTER TABLE "new_TraineeLayout" RENAME TO "TraineeLayout";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
