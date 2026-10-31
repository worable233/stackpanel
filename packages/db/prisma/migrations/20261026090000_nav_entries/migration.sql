-- 对标 #12.3：菜单树可编辑（排序 / 改名 / 隐藏 / 自定义链接）。
--
-- 只存「差异」：默认菜单仍由内核与插件提供，这里只记运营改过的项。
-- custom=true 的行是运营自己加的链接，与默认项同等对待，但不参与授权判断。
CREATE TABLE "nav_entries" (
    "id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "custom" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nav_entries_pkey" PRIMARY KEY ("id")
);

-- 同一区域同一个 href 只能有一条覆写：重复保存是修改，不是新增。
CREATE UNIQUE INDEX "nav_entries_surface_href_key" ON "nav_entries"("surface", "href");
CREATE INDEX "nav_entries_surface_idx" ON "nav_entries"("surface");
