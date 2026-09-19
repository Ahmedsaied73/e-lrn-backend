-- Paymob payments (from-scratch build, D3 money = whole EGP, D2 1-year access, D12 unique txn).
-- ONLY the payment-scope change is here. The generated diff also wanted to DROP/RENAME
-- pre-existing search indexes (schema/DB drift outside this feature) — deliberately excluded:
-- those are a separate audit item, not part of payments.
--
-- Apply via out-of-band procedure (repo convention; migrate dev's shadow DB fails on the
-- pre-existing lockdown migration's ALTER DEFAULT PRIVILEGES):
--   prisma db execute --file <this> --url $DIRECT_URL
--   prisma migrate resolve --applied 20260919140000_paymob_payments

-- 1) Enum: add intent-expiry + refund states (safe on Postgres 12+).
ALTER TYPE "PaymentStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

-- 2) Course.price: Float → whole-EGP Int. No fractions in practice (all rows are 0 today);
-- ROUND keeps the conversion defined if a fractional price ever appears.
ALTER TABLE "Course" ALTER COLUMN "price" SET DATA TYPE INTEGER USING (ROUND("price")::INTEGER);

-- 3) Payment: provider correlation + idempotency + money in whole EGP.
ALTER TABLE "Payment"
  ADD COLUMN "courseId" INTEGER,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EGP',
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'paymob',
  ADD COLUMN "providerReference" TEXT,
  ADD COLUMN "providerTxnId" TEXT,
  ADD COLUMN "providerCheckoutUrl" TEXT,
  ADD COLUMN "intentionExpiresAt" TIMESTAMP(3),
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "rawEvent" JSONB,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Legacy amounts were Float EGP; whole-EGP Int keeps the semantic (ROUND, not *100).
  ALTER COLUMN "amount" SET DATA TYPE INTEGER USING (ROUND("amount")::INTEGER);

-- 4) Enrollment: 1-year access window (null = permanent — grandfathered + admin grants).
ALTER TABLE "Enrollment" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- 5) Idempotency + lookup indexes.
CREATE UNIQUE INDEX "Payment_providerReference_key" ON "Payment"("providerReference");
CREATE UNIQUE INDEX "Payment_providerTxnId_key" ON "Payment"("providerTxnId");
CREATE INDEX "Payment_courseId_idx" ON "Payment"("courseId");
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- 6) FK: deleting a course must not delete payment history.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
