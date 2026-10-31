/**
 * 只有扩展、没有 HTTP 路由的插件夹具。
 *
 * 真实对应物是 `wowid`：它只贡献 `auth.provider`，一个路由也不注册。
 * 早期的 isolated worker 要求 `definition.routes` 必须是数组，于是这类包在
 * `ready` 帧之前就抛错，宿主只报「isolated plugin X exited before ready」，
 * 从错误里完全看不出「插件本来就没有路由」。没有路由是合法形态，不是缺陷。
 */
export default {
  manifest: {
    id: 'isolated-routeless-fixture',
    name: 'Routeless fixture',
    version: '1.0.0',
  },
  provider: {
    id: 'routeless',
    label: 'Routeless',
  },
};
