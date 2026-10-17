-- 用户级通知偏好（审计 §5 后续项：订阅偏好）。
--
-- 内核拥有：通知类型目录、管理员级策略（全局开关/默认渠道/锁定）与最终裁决；
-- 本表只存用户对「可配置」通道的显式覆盖（按 用户 × 类型 × 渠道）。
--
-- 仅对已在目录中声明（notification.type 扩展点或内核内建）的类型生效：未声明
-- 类型没有配置项，永远投递、不可关闭。注册/登录验证码走 identity 服务，根本
-- 不经过通知服务，因此天然不可配置。

CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preferences_userId_type_channelId_key"
  ON "notification_preferences"("userId", "type", "channelId");

CREATE INDEX "notification_preferences_userId_idx"
  ON "notification_preferences"("userId");

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
