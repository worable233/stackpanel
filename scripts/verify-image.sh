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
#   STACKPANEL_IMAGE_WORKFLOW  签发它的工作流文件名（默认按镜像名推断：
#                        `stackpanel-updater` → `publish-updater.yml`，其余 → `release.yml`）。
#                        两个镜像由不同工作流签名，身份正则写错就永远验不过。
#   COSIGN_EXPERIMENTAL  透传（旧版 cosign 需要 =1 才启用 keyless 校验）。
#
set -euo pipefail

info() { printf '\033[1;36m[verify]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[verify]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[verify]\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# 签发它的工作流：主镜像在 release.yml，updater 在 publish-updater.yml。
# 身份正则里写错文件名，验签就永远不过（反之写宽了等于不校验）。
WORKFLOW="${STACKPANEL_IMAGE_WORKFLOW:-}"
if [[ -z "$WORKFLOW" ]]; then
  # 只看仓库名（`${IMAGE_REF##*/}`），否则带 :tag / @sha256: 的引用永远匹配不上。
  case "${IMAGE_REF##*/}" in
    stackpanel-updater*) WORKFLOW="publish-updater.yml" ;;
    *) WORKFLOW="release.yml" ;;
  esac
fi
info "期望签发工作流：${WORKFLOW}"

# ---- 2. 标签 → 摘要 -------------------------------------------------------
# 必须拿到**清单索引**（multi-arch manifest list）的摘要：cosign 签的是索引，
# 拿平台清单摘要去验会得到「no signatures found」。三条路子按可靠性降级：
#   1. 已本地拉取 → RepoDigests 里存的就是拉取时用的那份清单（多架构镜像即索引摘要）；
#   2. 有 buildx → imagetools 的 `.Manifest.Digest` 就是索引摘要；
#   3. 都没有 → `docker manifest inspect --verbose`，它只给平台清单摘要，
#      验签大概率不过，所以明确告警，让调用方改用 @sha256:<索引摘要>。
resolve_digest() {
  local ref="$1" out=""
  # 1. 本地已拉取：RepoDigests 存的就是拉取时用的那份清单（多架构镜像即索引摘要）。
  out="$(docker image inspect "$ref" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed -E 's#^.*@##' || true)"
  # 2. 有 buildx：imagetools 的 `.Manifest.Digest` 就是索引摘要。
  if [[ -z "$out" ]] && docker buildx version >/dev/null 2>&1; then
    out="$(docker buildx imagetools inspect "$ref" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
  fi
  # 3. 直接问 registry（不下载层，不需要 buildx），私有包用 docker login 的凭据。
  if [[ -z "$out" ]]; then
    out="$(node "$SCRIPT_DIR/lib/image-digest.mjs" "$ref" 2>/dev/null || true)"
  fi
  # 4. 最后一招：`docker manifest inspect --verbose` 只给平台清单摘要，
  #    拿它验签大概率不过，所以明确告警，让调用方改用 @sha256:<索引摘要>。
  if [[ -z "$out" ]]; then
    out="$(docker manifest inspect --verbose "$ref" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const d=(Array.isArray(j)?j[0]:j)?.Descriptor?.digest;if(d)process.stdout.write(d)}catch{}})' \
      || true)"
    if [[ -n "$out" ]]; then
      warn "只解析到平台清单摘要（未拉取本地、没有 buildx、registry 也没给摘要）：多架构镜像请改用 @sha256:<索引摘要>"
    fi
  fi
  printf '%s' "$out"
}

DIGEST_REF="$IMAGE_REF"
if [[ "$IMAGE_REF" != *"@sha256:"* ]]; then
  info "解析标签为不可变摘要：${IMAGE_REF}"
  DIGEST="$(resolve_digest "$IMAGE_REF")"
  [[ -n "$DIGEST" ]] || fail "无法解析 ${IMAGE_REF} 的摘要（镜像不存在、未推送或未登录 registry？）"
  # 只在最后一个 `/` 之后有 `:tag` 时才剥标签，否则带端口的仓库名（host:5000/x）会被切坏。
  if [[ "${IMAGE_REF##*/}" == *:* ]]; then
    DIGEST_REF="${IMAGE_REF%:*}@${DIGEST}"
  else
    DIGEST_REF="${IMAGE_REF}@${DIGEST}"
  fi
fi
info "校验目标：${DIGEST_REF}"

# ---- 3. cosign keyless 校验 ----------------------------------------------
# 绑定「签发身份 = 本仓库 release.yml」+「OIDC 签发方 = GitHub Actions」，
# 从而阻止任何其他工作流 / 身份的伪造签名通过。
cosign verify \
  --certificate-identity-regexp "^https://github.com/${REPO}/.github/workflows/${WORKFLOW}@" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "$DIGEST_REF"

echo
info "签名校验通过：${DIGEST_REF}"
echo "请把上面的摘要与对应 Release Notes / GITHUB_STEP_SUMMARY 中的摘要核对一致。"
