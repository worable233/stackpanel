# `catalog/entries/` —— 市场目录条目的唯一来源

这里每个 `*.json` 是一个**已签名的插件包**的目录条目，由插件仓的打包脚本
（`StackPanel-plugins/scripts/pack-plugin.mjs`）生成，交给
`.github/workflows/publish-catalog.yml` 汇编成 `catalog.json` + `catalog.sig`。

不要手写，也不要手改。条目里的 `artifact.sha256` / `artifact.size` 是按 ZIP 的
真实字节算出来的，改一个空格就和实际资产对不上，实例安装会在下载校验阶段失败
（`摘要不匹配`），而目录本身仍然「有效」——排查成本极高。

## 一条条目在说什么

| 字段 | 含义 | 弄错会怎样 |
| --- | --- | --- |
| `id` / `version` | 组件标识与版本 | 与 ZIP 内 `manifest.json` 不一致时安装被拒 |
| `source.repository` | 允许的发布仓库 | 不在发布者白名单 `repositories` 里 → 拒绝 |
| `source.tag` / `source.asset` | Release tag 与资产名 | 必须真实存在，否则解析不到下载地址 |
| `compatibility.kernel` | 可安装的内核版本区间 | 区间不覆盖当前内核 → 门禁判为不兼容 |
| `compatibility.frontendAbi` | 前端 ABI 区间 | 同上 |
| `publisher` | 发布者标识 | 必须在 `CATALOG_PUBLISHERS` 白名单里 |
| `artifact.sha256` / `size` | 包体摘要与字节数 | 与资产不符 → 下载后校验失败 |

## 发布流程

见 `docs/RELEASE.md` §8：打包 → 上传 Release 资产 → 把条目提交到这里 →
配 `CATALOG_PUBLISHERS` → `gh workflow run publish-catalog.yml -f sequence=N -f publish=true`。

## 自查

```bash
# 条目能否汇编成目录（用临时私钥，产物不发布）
node scripts/release/build-catalog.mjs \
  --entries catalog/entries --config /tmp/catalog.config.json \
  --key-file /tmp/test-key.pem --out /tmp/catalog-out --key-id catalog-2026
```

输出 `entries: N` 且没有 `目录非法` 即为通过。
