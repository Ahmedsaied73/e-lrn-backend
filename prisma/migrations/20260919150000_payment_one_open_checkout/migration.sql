-- One open checkout per student+course (D5, structural).
--
-- The service already reuses a live PENDING payment, but two CONCURRENT
-- checkout requests could both miss it and create two PENDING rows — and a
-- student can then pay twice. This partial unique index makes that
-- impossible at the storage layer; the service catches the resulting P2002
-- and returns the winner's checkout URL.
--
-- Terminal rows (COMPLETED/FAILED/EXPIRED/REFUNDED) are unaffected: history
-- may hold any number of them per student+course.
CREATE UNIQUE INDEX "Payment_one_open_per_user_course"
  ON "Payment"("userId", "courseId")
  WHERE "status" = 'PENDING';