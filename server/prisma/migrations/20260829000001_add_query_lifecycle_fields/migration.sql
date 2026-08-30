-- Existing Query rows receive generation 1 and no resume stage.
ALTER TABLE "Query" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Query" ADD COLUMN "resumeStatus" TEXT;
