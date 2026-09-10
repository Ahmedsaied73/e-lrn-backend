-- CreateIndex
CREATE INDEX "Assignment_videoId_idx" ON "Assignment"("videoId");

-- CreateIndex
CREATE INDEX "AssignmentAnswer_questionId_idx" ON "AssignmentAnswer"("questionId");

-- CreateIndex
CREATE INDEX "AssignmentQuestion_assignmentId_idx" ON "AssignmentQuestion"("assignmentId");

-- CreateIndex
CREATE INDEX "Submission_assignmentId_idx" ON "Submission"("assignmentId");
