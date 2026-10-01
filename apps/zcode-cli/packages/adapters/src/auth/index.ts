// localhost 回调、共享凭据库与加密 cipher 已下沉到 @zcode/provider-node，
// 供 host（packages/services 登录编排）与 CLI 共用同一实现；此处仅保留 CLI 侧浏览器打开工具。
export * from "./browser.js";
export {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallback,
  type LocalhostOAuthCallbackServer,
  MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE,
  type McpOAuthCallbackDeniedError,
} from "@zcode/provider-node";
export type {
  SharedZCodeCredentialStore,
  SharedZCodeCredentialStoreOptions,
} from "@zcode/provider-node";
export { createSharedZCodeCredentialStore, loadSharedZCodeCredentialSync } from "@zcode/provider-node";
export { createZCodeCredentialCipher, type ZCodeCredentialCipher } from "@zcode/provider-node";
