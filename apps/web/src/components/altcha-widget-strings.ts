// @i18n-exempt — ALTCHA's vendor widget has no message catalog or per-element
// strings API; these strings are seeded into its global `$altcha.i18n` registry
// by captcha-field.tsx.

export const ALTCHA_LOCALES = [
  'zh-cn',
  'zh-tw',
  'zh-hk',
  'en-us',
  'fr-fr',
  'ja-jp',
  'ko-kr',
] as const;

export type AltchaLocale = (typeof ALTCHA_LOCALES)[number];

/**
 * ALTCHA ships only English strings and has no per-element `strings` API. Its
 * supported extension point is `globalThis.$altcha.i18n.set(locale, strings)`,
 * which must run after `widget.js` has been evaluated and before the element is
 * connected. Keep the full copy here so the checkpoint, errors and overlay are
 * localised too — not just the initial checkbox label.
 */
export const ALTCHA_STRINGS: Record<AltchaLocale, Record<string, string>> = {
  'zh-cn': {
    label: '点击验证',
    verified: '验证通过',
    verifying: '正在验证…',
    verificationRequired: '请先完成验证',
    error: '验证失败，请重试',
    expired: '验证已过期，请重新验证',
    reload: '重新加载',
    enterCode: '输入验证码',
    enterCodeAria: '输入你听到的验证码，按空格键播放音频',
    enterCodeFromImage: '请输入下方图片中的验证码',
    getAudioChallenge: '获取语音验证',
    loading: '加载中…',
    cancel: '取消',
    verify: '验证',
    waitAlert: '正在验证，请稍候…',
    ariaLinkLabel: 'ALTCHA 官方网站',
  },
  'zh-tw': {
    label: '點擊驗證',
    verified: '驗證通過',
    verifying: '正在驗證…',
    verificationRequired: '請先完成驗證',
    error: '驗證失敗，請重試',
    expired: '驗證已過期，請重新驗證',
    reload: '重新載入',
    enterCode: '輸入驗證碼',
    enterCodeAria: '輸入你聽到的驗證碼，按空白鍵播放音訊',
    enterCodeFromImage: '請輸入下方圖片中的驗證碼',
    getAudioChallenge: '取得語音驗證',
    loading: '載入中…',
    cancel: '取消',
    verify: '驗證',
    waitAlert: '正在驗證，請稍候…',
    ariaLinkLabel: 'ALTCHA 官方網站',
  },
  'zh-hk': {
    label: '點擊驗證',
    verified: '驗證通過',
    verifying: '正在驗證…',
    verificationRequired: '請先完成驗證',
    error: '驗證失敗，請重試',
    expired: '驗證已過期，請重新驗證',
    reload: '重新載入',
    enterCode: '輸入驗證碼',
    enterCodeAria: '輸入你聽到的驗證碼，按空白鍵播放音訊',
    enterCodeFromImage: '請輸入下方圖片中的驗證碼',
    getAudioChallenge: '取得語音驗證',
    loading: '載入中…',
    cancel: '取消',
    verify: '驗證',
    waitAlert: '正在驗證，請稍候…',
    ariaLinkLabel: 'ALTCHA 官方網站',
  },
  'en-us': {
    label: 'Click to verify',
    verified: 'Verified',
    verifying: 'Verifying…',
    verificationRequired: 'Verification required',
    error: 'Verification failed. Please try again.',
    expired: 'Verification expired. Please try again.',
    reload: 'Reload',
    enterCode: 'Enter code',
    enterCodeAria: 'Enter the code you hear. Press Space to play the audio.',
    enterCodeFromImage: 'To continue, enter the code from the image below.',
    getAudioChallenge: 'Get an audio challenge',
    loading: 'Loading…',
    cancel: 'Cancel',
    verify: 'Verify',
    waitAlert: 'Verifying… please wait.',
    ariaLinkLabel: 'ALTCHA official website',
  },
  'fr-fr': {
    label: 'Cliquez pour vérifier',
    verified: 'Vérifié',
    verifying: 'Vérification…',
    verificationRequired: 'Vérification requise',
    error: 'Échec de la vérification. Réessayez.',
    expired: 'Vérification expirée. Réessayez.',
    reload: 'Recharger',
    enterCode: 'Saisir le code',
    enterCodeAria: 'Saisissez le code que vous entendez. Appuyez sur Espace pour lire l’audio.',
    enterCodeFromImage: 'Pour continuer, saisissez le code de l’image ci-dessous.',
    getAudioChallenge: 'Obtenir un défi audio',
    loading: 'Chargement…',
    cancel: 'Annuler',
    verify: 'Vérifier',
    waitAlert: 'Vérification en cours… veuillez patienter.',
    ariaLinkLabel: 'Site officiel d’ALTCHA',
  },
  'ja-jp': {
    label: 'クリックして認証',
    verified: '認証済み',
    verifying: '認証中…',
    verificationRequired: '認証が必要です',
    error: '認証に失敗しました。もう一度お試しください。',
    expired: '認証の有効期限が切れました。もう一度お試しください。',
    reload: '再読み込み',
    enterCode: 'コードを入力',
    enterCodeAria: '聞こえたコードを入力してください。スペースキーで音声を再生します。',
    enterCodeFromImage: '続行するには、下の画像のコードを入力してください。',
    getAudioChallenge: '音声認証を取得',
    loading: '読み込み中…',
    cancel: 'キャンセル',
    verify: '認証',
    waitAlert: '認証中です。しばらくお待ちください。',
    ariaLinkLabel: 'ALTCHA 公式サイト',
  },
  'ko-kr': {
    label: '클릭하여 인증',
    verified: '인증됨',
    verifying: '인증 중…',
    verificationRequired: '인증이 필요합니다',
    error: '인증에 실패했습니다. 다시 시도해 주세요.',
    expired: '인증이 만료되었습니다. 다시 시도해 주세요.',
    reload: '새로 고침',
    enterCode: '코드 입력',
    enterCodeAria: '들리는 코드를 입력하세요. 스페이스 키를 누르면 오디오가 재생됩니다.',
    enterCodeFromImage: '계속하려면 아래 이미지의 코드를 입력하세요.',
    getAudioChallenge: '음성 인증 받기',
    loading: '불러오는 중…',
    cancel: '취소',
    verify: '인증',
    waitAlert: '인증 중입니다. 잠시만 기다려 주세요.',
    ariaLinkLabel: 'ALTCHA 공식 웹사이트',
  },
};

export function resolveAltchaLocale(value: string | null | undefined): AltchaLocale {
  const normalized = (value ?? '').replace(/_/g, '-').toLowerCase();
  if (ALTCHA_LOCALES.includes(normalized as AltchaLocale)) return normalized as AltchaLocale;
  const [base] = normalized.split('-');
  if (base === 'zh') {
    if (normalized.includes('-tw')) return 'zh-tw';
    if (normalized.includes('-hk')) return 'zh-hk';
    return 'zh-cn';
  }
  if (base === 'en') return 'en-us';
  if (base === 'fr') return 'fr-fr';
  if (base === 'ja') return 'ja-jp';
  if (base === 'ko') return 'ko-kr';
  return 'en-us';
}
