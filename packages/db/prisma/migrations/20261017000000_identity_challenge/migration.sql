-- 注册邮箱验证与独立身份挑战（审计 §5）。
--
-- users.emailVerifiedAt：邮箱所有权验证时间。启用「注册邮箱验证」后仅在验证
--   通过时写入；未启用或第三方登录创建的可为空（NULL 不代表已验证）。
--
-- identity_challenges：内核拥有的短时、单次、限次验证码。按「规范化邮箱 + 用途」
--   寻址，未注册用户尚无可靠 userId，因此**不**落进 notifications 表。
--   只保存验证码摘要与盐；明文只在发送时出现一次，绝不进入通知/SSE/审计/日志。

ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

CREATE TABLE "identity_challenges" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "codeSalt" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "locale" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_challenges_pkey" PRIMARY KEY ("id")
);

-- 按「邮箱 + 用途 + 是否已消费」找当前活跃挑战（校验与限流）。
CREATE INDEX "identity_challenges_email_purpose_consumedAt_idx"
  ON "identity_challenges"("email", "purpose", "consumedAt");

-- 清理过期挑战。
CREATE INDEX "identity_challenges_expiresAt_idx" ON "identity_challenges"("expiresAt");
