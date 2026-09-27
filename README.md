# ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCode 是本地优先的 AI 编程工作台，提供桌面应用和终端 Agent。模型 Provider 通过自定义 API-key 配置接入。本仓库包含桌面客户端、共享 UI，以及 Agent CLI 与运行时源码。

## 更新

- 2026-9-23：更新至 ZCode v3.14.3 版本。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                  |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源                                          |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤 |

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### ZCode 命令行版

命令行包含 TUI 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；其他参数交给现有 Agent CLI 处理。命令行在本机运行，无需 Electron。

```bash
# 查看参数
pnpm --filter @zcode/cli dev --help

# 源码入口直接运行
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

## 配置

根目录 [.env.example](.env.example) 提供构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |

运行时变量可在启动命令的环境中显式设置。内置 Provider 模板见 [config/README.md](config/README.md)。

## 打包

第三方声明由 `node scripts/generate-third-party-notices.mjs` 生成，声明内容见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

### ZCode 命令行版

构建入口为 `pnpm build:sea`，构建 CLI/TUI 并组装单文件可执行产物（SEA，内嵌 Node 运行时）。默认 CLI bundle 产物仍需 Node.js，版本以 `mise.toml` 为准。

```bash
# 交叉平台目标
pnpm --dir apps/zcode-cli sea -- --target linux-x64
```

## 仓库结构

| 目录                                                                       | 职责                                       |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                                         | Electron Main、Host、Renderer 与桌面打包   |
| `packages/ui`                                                              | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                                        | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client`                       | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`、`packages/model-option-map` | 自定义 API-key Provider 能力与模型选项映射 |
| `packages/formal-proof`                                                    | 形式化状态模型 playground                  |
| `apps/zcode-cli`                                                           | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                                         | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
