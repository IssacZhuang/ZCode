import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IProviderUsageService } from "./model-provider/providerUsageService.js";
import type { IChatGptAccountService } from "./model-provider/chatgptAccountService.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";

/** UI 层消费的统一服务接口 */
export interface IServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  readonly fileWatcherService: IFileWatcherService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 供应商用量/余额查询（按 base_url 域名识别内置适配器）。 */
  readonly providerUsageService: IProviderUsageService;
  /** ChatGPT（SIWC）账号登录服务；账号态以服务端事实为准，UI 不缓存。 */
  readonly chatGptAccountService: IChatGptAccountService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  readonly usageStatsService: IUsageStatsService;
  readonly clientScenesService: IClientScenesService;
  /** 闲时任务管理（独立服务面）。 */
  readonly skillsService: ISkillsService;
  readonly mcpSyncService: IMcpSyncService;
  /** 设置页插件管理（UI 不再直触 zcodeAgentService 的 plugins/* 面） */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly settingsSyncService: ISettingsSyncService;
}
