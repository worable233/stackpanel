-- 0.1.3 数据修正：清理审计发现的孤儿与幽灵实例
--
-- 全部为**只读检查**在前、修正在后；每一步都先看清再执行。
-- 在 `psql` 里按段执行，不要整段粘贴运行。
--
-- 背景：
--   * 审计 Z-5「凭证与资源非原子」→ 有资源、无凭证的上游（ed6205f7）
--   * 审计 §3「绑定上游服务」→ 无商品/无订单/无凭证的幽灵实例（bound-<sha256>）
--   * 审计 Z-7「同一上游可重复创建」→ 同名同地址的多条 moebun
--
-- 0.1.3 起：创建已原子化（同一事务写资源+凭证），无映射的绑定直接 409，
-- `name`/同地址同协议重复创建被拒。**但存量脏数据不会自动消失**，需要显式处理。

-- ---------------------------------------------------------------
-- 1) 先看清：上游配置与凭证的对应关系
-- ---------------------------------------------------------------

-- 1a. 有资源、无凭证的上游（创建时第二步失败的遗留）
SELECT u.id,
       u.spec->>'name'    AS name,
       u.spec->>'baseUrl' AS base_url,
       u.created_at
  FROM "ext_zjmf-upstream_upstream" u
 WHERE NOT EXISTS (
         SELECT 1 FROM secrets s
          WHERE s.key = 'plugin.zjmf-upstream.credentials.' || u.id
       );

-- 1b. 有凭证、无资源（反向孤儿：资源被删了但凭证还在）
SELECT s.key
  FROM secrets s
 WHERE s.key LIKE 'plugin.zjmf-upstream.credentials.%'
   AND NOT EXISTS (
         SELECT 1 FROM "ext_zjmf-upstream_upstream" u
          WHERE s.key = 'plugin.zjmf-upstream.credentials.' || u.id
       );

-- 1c. 可重复：同名或同地址同协议
SELECT u.spec->>'name'    AS name,
       u.spec->>'baseUrl' AS base_url,
       u.spec->>'protocol' AS protocol,
       count(*)           AS copies,
       array_agg(u.id)    AS ids
  FROM "ext_zjmf-upstream_upstream" u
 GROUP BY 1, 2, 3
HAVING count(*) > 1;

-- 1d. 幽灵实例：本地商品不存在，或没有订单且来源是后台绑定
SELECT si.id,
       si.spec->>'userId'            AS user_id,
       si.spec->>'productId'         AS product_id,
       si.spec->>'providerServiceId' AS provider_service_id,
       si.spec->>'state'             AS state,
       si.spec->>'orderId'           AS order_id,
       si.spec->'runtime'->>'origin' AS origin
  FROM "ext_store_service-instance" si
 WHERE si.id LIKE 'bound-%'
    OR (
         si.spec->>'orderId' IS NULL
         AND si.spec->>'providerServiceId' IS NOT NULL
       );

-- 1e. 上面那些幽灵实例里，商品 id 在本库查不到的（真正没法续费/退款的那种）
SELECT si.id, si.spec->>'productId' AS product_id
  FROM "ext_store_service-instance" si
 WHERE (si.id LIKE 'bound-%' OR si.spec->>'orderId' IS NULL)
   AND si.spec->>'productId' IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM "ext_store_product" p
          WHERE p.id = si.spec->>'productId'
       );

-- ---------------------------------------------------------------
-- 2) 修正
-- ---------------------------------------------------------------

-- 2a. 给无凭证的上游打标记，而非直接删除。
--     直接删会连带丢掉管理员已经填好的价格/同步配置；标记后由人确认。
--     注意：0.1.3 的列表已能显示「凭证未配置」，所以也可以什么都不做。
UPDATE "ext_zjmf-upstream_upstream"
   SET annotations = COALESCE(annotations, '{}'::jsonb)
                    || '{"stackpanel.io/audit-0.1.3": "missing-credentials"}'::jsonb
 WHERE NOT EXISTS (
         SELECT 1 FROM secrets s
          WHERE s.key = 'plugin.zjmf-upstream.credentials.'
                     || "ext_zjmf-upstream_upstream".id
       );

-- 2b. 删除反向孤儿凭证（资源已不存在）。
--     ⚠ 先跑 1b 确认列出来的都是真的孤儿；删凭证不可恢复。
-- DELETE FROM secrets s
--  WHERE s.key LIKE 'plugin.zjmf-upstream.credentials.%'
--    AND NOT EXISTS (
--          SELECT 1 FROM "ext_zjmf-upstream_upstream" u
--           WHERE s.key = 'plugin.zjmf-upstream.credentials.' || u.id
--        );

-- 2c. 重复上游：保留同步配置更完整的那条，其余停用（**不删**，删了会丢历史绑定）。
--     ⚠ 执行前先用 1c 看清哪条是你想留的。
-- UPDATE "ext_zjmf-upstream_upstream" u
--    SET spec = jsonb_set(spec, '{enabled}', 'false'::jsonb)
--  WHERE u.id IN ( /* 把 1c 里不保留的 id 填进来 */ );

-- 2d. 幽灵实例：打来源标记并在前台禁止续费入口。
--     不要直接删除：用户侧可能已经看到过它，删掉会让「我的服务」突然少一条。
UPDATE "ext_store_service-instance" si
   SET spec = jsonb_set(
                spec,
                '{runtime}',
                COALESCE(spec->'runtime', '{}'::jsonb)
                  || jsonb_build_object(
                       'origin',
                       COALESCE(spec->'runtime'->>'origin', 'admin-migration')
                     )
              )
 WHERE si.id LIKE 'bound-%'
   AND (si.spec->'runtime'->>'origin') IS NULL;

-- ---------------------------------------------------------------
-- 3) 遗留的人工确认项
-- ---------------------------------------------------------------
-- * 上面 2d 打上 admin-migration 的实例，续费/退款入口必须由 store 插件按
--   origin 排除（见 operations.ts 的 origin 注释）。**仅打标记还不够**，
--   代码侧要一起看。
-- * 重复上游停用后，绑定到被停用那条的本地商品需要重新指向保留下来的那条，
--   否则同步会一直跳过它们。
