# 内置配置

## Provider 模板

`config/provider/zcode-builtin.json` 是自定义 API-key 模型 Provider 的内置模板文件（zcode-builtin release，经 `packages/provider-node` 的 schema 校验）。应用从打包文件读取，未设置 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 时使用内置配置；构建期由 `scripts/builtin-provider-config.mjs` 复用同一校验，避免打包成功后才发现 Schema 不兼容。
