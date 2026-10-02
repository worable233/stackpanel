#!/usr/bin/env bash
#
# 校验 StackPanel 发布镜像的 cosign 签名（keyless）。
#
# 用法：
#   bash scripts/verify-image.sh <镜像引用>
#   bash scripts/verify-image.sh ghcr.io/<owner>/stackpanel@sha256:<digest>
#   bash scripts/verify-image.sh ghcr.io/<owner>/stackpanel:v1.2.3
#
# 它做的事：
#   1. 若给了标签（非 @sha256:），先解析为不可变摘要，再校验摘要——避免「TOCTOU」：
#      标签可能被覆盖，摘要不会。
#   2. 用 cosign 校验 keyless 签名：签发身份必须是本仓库的 release.yml 工作流，
#      OIDC 签发方必须是 GitHub Actions。
#   3. 打印摘要，供与 Release Notes 核对。
#
# 环境变量：
#   STACKPANEL_REPO      期望的 GitHub 仓库（owner/name），默认从 git remote 推断；
#                        无 remote 时必须显式给出，否则报错退出。
#   COSIGN_EXPERIMENTAL  透传（旧版 cosign 需要 =1 才启用 keyless 校验）。
#
set -euo pipefail

info() { printf '\033[1;36m[verify]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[verify]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[verify]\033[0m %s\n' "$*" >&2; exit 1; }

IMAGE_REF="${1:-}"
[[ -n "$IMAGE_REF" ]] || fail "用法：bash scripts/verify-image.sh <镜像引用>（如 ghcr.io/owner/stackpanel:v1.2.3）"

command -v cosign >/dev/null 2>&1 \
  || fail "未找到 cosign。安装：https://docs.sigstore.dev/cosign/system_config/installation/"

# ---- 1. 解析期望的签发仓库 -------------------------------------------------
REPO="${STACKPANEL_REPO:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(git config --get remote.origin.url 2>/dev/null \
    | sed -E 's#(git@|https?://)github\.com[:/]##; s#\.git$##' || true)"
fi
[[ -n "$REPO" ]] || fail "无法推断 GitHub 仓库。请设置 STACKPANEL_REPO=owner/name 后重试。"
info "期望签发仓库：${REPO}"

# ---- 2. 标签 → 摘要 -------------------------------------------------------
DIGEST_REF="$IMAGE_REF"
if [[ "$IMAGE_REF" != *"@sha256:"* ]]; then
  info "解析标签为不可变摘要：${IMAGE_REF}"
  DIGEST="$(docker buildx imagetools inspect "$IMAGE_REF" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
  [[ -n "$DIGEST" ]] || fail "无法解析 ${IMAGE_REF} 的摘要（镜像不存在、未推送或未登录 registry？）"
  DIGEST_REF="${IMAGE_REF%%:*}@${DIGEST}"
fi
info "校验目标：${DIGEST_REF}"

# ---- 3. cosign keyless 校验 ----------------------------------------------
# 绑定「签发身份 = 本仓库 release.yml」+「OIDC 签发方 = GitHub Actions」，
# 从而阻止任何其他工作流 / 身份的伪造签名通过。
cosign verify \
  --certificate-identity-regexp "^https://github.com/${REPO}/.github/workflows/release.yml@" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$DIGEST_REF"

echo
info "签名校验通过：${DIGEST_REF}"
echo "请把上面的摘要与对应 Release Notes / GITHUB_STEP_SUMMARY 中的摘要核对一致。"
