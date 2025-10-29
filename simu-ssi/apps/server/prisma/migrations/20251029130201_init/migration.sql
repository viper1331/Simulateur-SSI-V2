-- CreateTable
CREATE TABLE "SiteConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "evacOnDAI" BOOLEAN NOT NULL DEFAULT false,
    "evacOnDMDelayMs" INTEGER NOT NULL DEFAULT 300000,
    "processAckRequired" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProcessAck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "isAcked" BOOLEAN NOT NULL DEFAULT false,
    "ackedBy" TEXT,
    "ackedAt" DATETIME,
    "clearedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ManualCallPoint" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "zoneId" TEXT NOT NULL,
    "isLatched" BOOLEAN NOT NULL DEFAULT false,
    "lastActivatedAt" DATETIME,
    "lastResetAt" DATETIME
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "zoneId" TEXT,
    "propsJson" TEXT
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "json" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL,
    "trainerId" TEXT,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,
    "source" TEXT NOT NULL,
    "zoneId" TEXT,
    "payloadJson" TEXT
);

-- CreateTable
CREATE TABLE "Score" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "rubricJson" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "comments" TEXT
);

-- CreateIndex
CREATE INDEX "ManualCallPoint_zoneId_idx" ON "ManualCallPoint"("zoneId");
