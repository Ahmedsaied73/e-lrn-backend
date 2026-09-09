-- Enable Row Level Security (deny-by-default) on all app tables.
-- The app connects as table owner (bypasses RLS); anon/authenticated hold no grants.
ALTER TABLE "public"."Assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."AssignmentAnswer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."AssignmentQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."BunnyVideo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."BunnyVideoProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Certificate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Course" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."GateExemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."LearningPath" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Quiz" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."QuizAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."Video" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."_CoursesInPath" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."_Prerequisites" ENABLE ROW LEVEL SECURITY;
