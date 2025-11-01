-- Add outOfService flag to Device entries
ALTER TABLE "Device" ADD COLUMN "outOfService" BOOLEAN NOT NULL DEFAULT false;
