-- 对标 #12.4：逐页 SEO 覆写（标题/描述/分享图/canonical/noindex）。
--
-- 路径唯一：一个页面只有一条覆写，重复保存是修改不是新增。
-- noindex 单独建索引：sitemap 聚合时按它一次性取出所有「不得出现」的路径。
CREATE TABLE "seo_pages" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "ogImage" TEXT,
    "canonical" TEXT,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seo_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seo_pages_path_key" ON "seo_pages"("path");
CREATE INDEX "seo_pages_noindex_idx" ON "seo_pages"("noindex");
