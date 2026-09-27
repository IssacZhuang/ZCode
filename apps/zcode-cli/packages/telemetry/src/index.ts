// 本地个人版裁剪：远程 OTLP 上报（OTLPTraceExporter / OTLPMetricExporter、OTEL_EXPORTER_OTLP_*、
// device-mid 身份与 AgentTelemetryRuntimeOwner 装配）已随远端遥测链路整体移除。
// 本地日志（service logger、stderr、debug 日志）不经过本包；模型 IO 记录在
// @zcode/adapters 的 modelIo 目录中本地落盘，同样不依赖本包。
// 保留空包仅为兼容工作区解析与既有 tsc -b 项目列表。
export {};
