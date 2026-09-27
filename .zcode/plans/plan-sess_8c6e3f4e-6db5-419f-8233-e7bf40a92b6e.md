# ZCode 个人分支瘦身计划

目标：把仓库变成纯本地的个人桌面 Agent 应用。分 8 个阶段执行，每阶段结束跑 `pnpm typecheck` + `pnpm lint`（至少覆盖受影响包）并单独提交一个 commit 到 main（此仓库即个人分支）。

## 保留的核心

- Agent 会话运行时全链路（`apps/zcode-cli` 本体、stdio 协议、desktop-continuous 实时链路）
- **自定义模型供应商配置**：Settings 模型供应商页通用部分、`packages/provider` 配置层、`provider_config.json` 个人配置；`zcode-builtin.json` 保留通用厂商模板 + zai/bigmodel 的 API-key 模板（可用 API key 接 GLM）
- 插件运行时与管理（已装插件启停/卸载、MCP/skills/commands/hooks 管理页）；CLI 侧 marketplace 引擎保留——内置插件（browser-use/documents 等）靠它 seeding
- cron 定时任务（本地调度）、内嵌浏览器（browser-use 工具）、多窗口/工作区标签、诊断功能（导出日志/清数据/资源管理器/devtools）

## 阶段 1：删除远程工作区 + web/server 三包（用户已确认）

- 整包删除：`packages/web`、`packages/server`、`packages/zcode-server-cli`；`pnpm-workspace.yaml`、根 package.json scripts（dev:web/dev:server/prepare:remote-assets/prepare-prebuilds 等）、typecheck 脚本同步清理
- Desktop：删 `remoteWorkspaceServiceCollection.ts`、`windowRemoteConnectionRegistry.ts`、`desktopRemoteSessions.ts`、`desktopMainIpcRemote.ts`、`desktopWslTargetResolver.ts`、renderer 的 `remoteWorkspaceSessionServices.ts`、`desktopRuntimeEnv.ts` 远程段
- UI：删 `SSHDialog`、`RemoteConnection*`、`useRemoteConnectionForm`、`remoteWorkspaceSessionStore`、`useRemoteWorkspaceHistory`；移除 `allowRemoteWorkspace` prop 链
- `packages/client` 只留 messageport 连接，删 websocket；删 `harness/remote/`、docker 相关文件
- `workspaceIdentity` 抽象保留（本地多工作区去重仍用），仅删远程连接创建链路

## 阶段 2：移除智谱账号/登录（保留自定义 provider）

- Services 删除：`oauth/**`（含 providers/repo）、`coding-plan-subscription/**`、`official-mcp/**`、`usage-stats` 中 bigmodel/zcodeMcp 配额 provider（保留 app 自身用量统计）、`session/offPeak*`、`model-provider/accountProvider*` 系列（credential/requestAuth/availability/legacy 迁移器）
- `node.ts`：摘除 IOAuthService 注册与 account source 接线，改接已有的 `EmptyAccountProviderConfigSource`（zhipu-account 类型 fail-closed 失效）
- `packages/provider`：access type 收敛为 `api-key`；删 `account-provider-service/resolution/state`；`zcode-builtin.json` 删 `account:*` 规则与 coding-plan 内容，保留 api-key 模板
- Shared 删除：`oauth.ts`、`official-mcp-auth.ts`、`coding-plan-subscription.ts`、`off-peak-types.ts`、usage-quota 中纯 coding-plan 部分；`validationAppSettings.ts` 删 `providerFamilyDomain`
- UI 删除：`WelcomeScreen` 登录态、`login/**`（LoginApiKeyForm 为 zai/bigmodel 专用）、`CodingPlan*` 全套（升级/嵌入 webview/用量面板）、sidebar footer 账号区（头像/计划徽章/登录菜单）、model-provider-section 的 `CodingPlan*/StartPlan*/oauthActions/BigModelRegistrationHint/ProviderFamilyModeHeader`、`root/*oauth*` 效果、usage-stats 的 coding-plan 面板
- 启动门：删 `useProviderAvailabilityLoginEntryGuard` 的登录拦截——无可用 provider 时不再弹登录页，聊天空态提示去设置配置供应商；store 删 `user/oauthError/loginEntry` 等字段
- Desktop：删 OAuth deep-link（`desktopOAuthDeepLink` 等）、`preload/codingPlanWebview.ts`、`BIGMODEL_OAUTH_APP_SECRET` 注入
- CLI：删 `/login` 命令（`bootstrap/src/auth-login.ts`、`login-flow.ts`）、`adapters/src/auth/**`、`official-coding-plan-gateway.ts`、`standalone-account-provider-runtime.ts`；`model-execution.ts` 删 requestAuth 分支只留 api-key 路径；**DB migration 文件保留**（兼容既有 `~/.zcode` 本地数据）
- i18n：删 `login.*`、`settings.provider.*` coding-plan 等 key

## 阶段 3：移除手机远控（bots）

- Services 删除：`bots/**`（~14k 行，微信/飞书/Telegram 通道与配对注册）、`window-controller/**`（手机窗口投影）、`prompt-attachment-transfer/**`、`cronBotDelivery`
- Desktop：`taskRealtimeBus.ts` 只删 relay/bot 分支（**desktop-continuous 是桌面 UI 自身链路，保留**）；删 `broadcastHub`、`remoteMediaPreviewProxy`、`windowHostControllerService/Projection`、bot attachment 路径（renderer attachment 保留）、ARMS 远控遥测
- UI 删除：`BotsDialog/**`、`WebRemoteControlDialog`、`WorkspaceWebRemoteControlTrigger`、`remotePinnedTaskStore`、`remoteTimelineTaskStore`、`root/botsTask*`、`useBotBroadcastEffects`、TaskListItem 的 mobileActive 标记
- Shared：删 `bots.ts`、task-realtime 的 `relay_bridge` 交付分支、channels 的 `BotRemoteWorkspace*`
- cron 调度器保留，仅去 bot 投递分支

## 阶段 4：移除插件市场 UI（保留插件运行时与管理）

- UI 删除：`PluginStorePage/ListView/DetailView/Card/Avatar/SourcesDialog`、`AddMarketplaceSourceDialog`、`PluginAddMenu`、`pluginStoreListing/TryPrompt/Search/SourceLabel`、`officialMarketplaceAutoRefresh`、`pluginCreatorPrefill`、`usePluginStoreOrder`、`pluginStoreNavigation.ts`、store 的 `pluginStore.ts`、`hooks/usePlugins.ts`
- `WorkspaceMainView` 删 `plugin-store` 变体；清理 App/WorkspaceShellLayout/WorkspaceSidebar/SettingsPage 接线；`PluginsSection` 删"浏览市场"入口，保留已装插件管理 + MCP/skills/commands tabs
- `WorkspacePluginPreview`（@ 提及选择器）保留，删跳转市场的调用
- Services：删已退役的 `pluginsService.ts` stub；`pluginManagementService` 保留（启停/卸载仍走 CLI 协议）
- CLI marketplace 引擎、协议方法（install/update/uninstall）保留

## 阶段 5：移除引导

- 删除 `ui/src/onboarding/**`（职业引导 + 迁移向导，含 Claude/外部 agent 导入）、`services/src/onboarding/**`、store 的 `newUserOnboardingOpen/requestOnboardingDialog`、SettingsPage 引导入口行、`ProactiveSuggestionsSetting`、`useOnboardingTrigger/useOnboardingTelemetry`
- 删除空态建议提示：`v4/featureSuggestedPrompts.ts` + `ConversationDraftSuggestedPrompts` 系列（其内容依赖官方插件市场安装流程）
- 清理 `settings.onboardingOccupation/proactiveSuggestionsEnabled` 持久化 key

## 阶段 6：移除帮助 + 反馈系统

- 删除 `WorkspaceHelpMenuButton`、`helpMenuActions`、`productDocs`、`ui/src/feedback/**`（17 文件）、`services/src/feedback/**`、`shared/src/feedback*.ts`、`desktopHelpConfig`、`helpAppConfig`
- desktopCommandHandlers：删 ShowAbout/OpenChangelog/OpenCommunity/OpenFeedback/CheckForUpdates；导出日志/清数据/资源管理器/devtools 保留，挪入设置页或应用菜单
- 错误边界中触发反馈的入口改为仅展示错误信息

## 阶段 7：移除遥测、自动更新、会话分享、CUA、远程配置

- 遥测：删 `telemetryCore`（deviceMid/日活上报）、conversation-telemetry 上报、ARMS（`appARMSBootstrap`、`@arms/rum-electron` 及根 package.json patch）、OTLP exporter、`desktopTelemetryFetch`；`appTelemetry` 收敛为本地 no-op（调用点遍布 settings，逐步清理）；CLI telemetry 删远端上报保留本地日志
- 自动更新（已确认）：删 `autoUpdater`、`manifestUpdateProvider`、`forceUpdateGuard/Prompt`、`UpdateStatus*` UI 全套、`useDesktopDesktopMenu` 相关、electron-updater 依赖
- 会话分享（发布到 zcode.z.ai）：删 `services/src/conversation-share/**`、`ConversationShareMenu/PermissionPicker`、ui 的 conversation-share-readonly 导出
- CUA：删 `packages/zcode-cua` stub 与 desktop CUA 权限面板/IPC（`zcodePipFocusRouter` 等）
- 远程配置下发：删 `remoteAppConfig`、`zcodeBuiltinRemoteConfig`（内置 provider 配置改为纯本地打包）、clientConfigService 中 store 排序等远程字段
- 依赖清理：`@larksuiteoapi/node-sdk`、`qrcode`、`stripe`、`electron-updater`、`@arms/*` 等

## 阶段 8：全局清理与验证

- i18n 全量清理死 key；`pnpm knip` 清 unused exports/deps；architecture-policy.yaml 与 `.agents/skills/` 中引用已删功能的说明清理
- 文档同步：AGENTS.md（删手机远控/远程工作区/协议相关指令段）、CONTEXT.md（插件商店词汇表删或改）、README 检查
- 全量验证：`node scripts/check-workspace-freshness.mjs` → `pnpm typecheck` → `pnpm lint` → `pnpm architecture:check` → `pnpm verify:pre-push` → `pnpm dev:desktop` 冒烟启动（如环境受限则如实说明）；核对设置页可新增自定义 provider 并连通

## 风险与边界

- `apps/zcode-cli` 是运行时本体，只做账号相关与遥测上报的摘除，不动核心工具/会话逻辑
- taskRealtime/zcode-protocol 只删 relay/bot 分支，桌面自身实时链路不动
- 个人 `provider_config.json` 不受影响；`credentials.json` 中 OAuth key 不再读写
- 既有 `~/.zcode` 本地数据靠保留的 DB migration 平滑升级
- 每阶段独立可编译、独立提交，出错可单独回滚
