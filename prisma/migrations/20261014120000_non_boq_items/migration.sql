-- A non-BOQ (extra) item on a bill to the client: a BOQ line flagged as outside the tender, billed
-- at its own rate without the tender premium. See `BOQTaskItem.nonBoq`.
ALTER TABLE "projects"."BOQTaskItem" ADD COLUMN "nonBoq" BOOLEAN NOT NULL DEFAULT false;
