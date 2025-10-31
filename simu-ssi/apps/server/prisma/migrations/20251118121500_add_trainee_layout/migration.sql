CREATE TABLE IF NOT EXISTS "TraineeLayout" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "configJson" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "TraineeLayout" ("id", "configJson", "updatedAt") VALUES (
  1,
  '{"boardModuleOrder":["cmsi-status","uga","das","manual-evac","dai","dm-zf1","dm-zf2","dm-zf3","dm-zf4","dm-zf5","dm-zf6","dm-zf7","dm-zf8"],"controlButtonOrder":["silence","ack","reset-request","reset-dm-zf1","manual-evac-toggle"],"sidePanelOrder":["access-control","event-recap","instructions"]}',
  CURRENT_TIMESTAMP
)
ON CONFLICT("id") DO UPDATE SET
  "configJson" = excluded."configJson",
  "updatedAt" = CURRENT_TIMESTAMP;
