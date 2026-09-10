-- D-1: GateExemption.bunnyVideoId FK (orphans verified absent)
ALTER TABLE "GateExemption" ADD CONSTRAINT "GateExemption_bunnyVideoId_fkey" FOREIGN KEY ("bunnyVideoId") REFERENCES "BunnyVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- D-3: per-course position uniqueness (NULLs exempt, legacy-safe)
CREATE UNIQUE INDEX "BunnyVideo_courseId_position_key" ON "BunnyVideo"("courseId", "position");
