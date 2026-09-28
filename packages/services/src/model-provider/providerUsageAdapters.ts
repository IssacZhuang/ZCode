/**
 * 供应商用量/余额查询适配器（provider-agnostic，不绑定智谱）。
 *
 * 端点与解析规则参照各供应商公开接口（实现依据：cc-switch 开源实现，MIT）：
 * - coding-plan：智谱 GLM / Kimi / MiniMax 的套餐限额（five_hour + weekly 时间窗）。
 * - balance：DeepSeek / SiliconFlow / OpenRouter / StepFun / Novita 的账户余额。
 * 解析函数均为纯函数（不做网络 IO），便于用响应 fixture 做单测。
 */
import type { ProviderUsageAdapterId, ProviderUsageKind, ProviderUsageTier } from "@zcode/shared";

interface ProviderUsageRequestPlan {
  readonly url: string;
  readonly headers: Record<string, string>;
}

type ProviderUsageParseOutcome =
  | { readonly ok: true; readonly tiers: readonly ProviderUsageTier[] }
  | { readonly ok: false; readonly message: string };

interface ProviderUsageAdapter {
  readonly id: ProviderUsageAdapterId;
  readonly kind: ProviderUsageKind;
  buildRequest(baseUrl: string, apiKey: string): ProviderUsageRequestPlan;
  parseResponse(body: unknown): ProviderUsageParseOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 数值字段兼容数字与数字字符串（如 `100` 与 `"100"`）。 */
function parseNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && value.trim() !== "") return parsed;
  }
  return undefined;
}

/** epoch 时间戳（自动区分秒/毫秒）转 ISO 8601；0/负值视为无重置时间。 */
function epochToIso(value: unknown): string | undefined {
  if (typeof value === "string") return value; // 已是 ISO 字符串则原样透传
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

// ── 智谱 GLM ────────────────────────────────────────────────
// GET {quotaBase}/api/monitor/usage/quota/limit；Authorization 头直接放 key，不加 Bearer 前缀。
// bigmodel.cn 与 z.ai 共用同一后端，字段一致：limits[] 的 unit:3 → 5 小时窗、unit:6 → 周窗。

function zhipuQuotaBase(hostname: string): string {
  return hostname.endsWith("bigmodel.cn") ? "https://open.bigmodel.cn" : "https://api.z.ai";
}

/** 窗口条目：已用百分比 + 可选重置时间（ms epoch）。 */
interface ZhipuLimitEntry {
  readonly resetMs: number | null;
  readonly usedPercentage: number;
  readonly resetsAt: string | undefined;
}

/**
 * 分类优先级：unit 显式标识窗口（3=five_hour、6=weekly）。不能按 nextResetTime
 * 排序代替——周期末尾每周窗口会比 5 小时窗口更早重置，时间排序必然把两桶标反
 * （cc-switch issue #3036 实测）。unit 缺失时的兜底：无 reset 的条目优先归
 * five_hour（5 小时桶在 0% 等状态可能没有 reset），其余按 reset 升序补位。
 * 老套餐只回 1 条 TOKENS_LIMIT，自然降级为仅展示 five_hour。
 */
function parseZhipuUsageResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  if (body.success === false) {
    return { ok: false, message: `API error: ${String(body.msg ?? "unknown")}` };
  }
  const data = body.data;
  if (!isRecord(data)) {
    return { ok: false, message: "响应缺少 data 字段" };
  }
  const limits = Array.isArray(data.limits) ? data.limits : [];
  let fiveHour: ZhipuLimitEntry | null = null;
  let weekly: ZhipuLimitEntry | null = null;
  const unclassified: ZhipuLimitEntry[] = [];
  for (const item of limits) {
    if (!isRecord(item)) continue;
    const limitType = typeof item.type === "string" ? item.type.toLowerCase() : "";
    // 大小写不敏感比较：上游若把 "TOKENS_LIMIT" 改成小写或驼峰依然能识别
    if (limitType !== "tokens_limit" && limitType !== "credit_limit") {
      continue;
    }
    const entry: ZhipuLimitEntry = {
      resetMs: typeof item.nextResetTime === "number" ? item.nextResetTime : null,
      usedPercentage: typeof item.percentage === "number" ? item.percentage : 0,
      resetsAt: epochToIso(item.nextResetTime),
    };
    const unit = typeof item.unit === "number" ? item.unit : null;
    if (unit === 3 && fiveHour === null) {
      fiveHour = entry;
    } else if (unit === 6 && weekly === null) {
      weekly = entry;
    } else {
      unclassified.push(entry);
    }
  }
  // 无 reset 的排最前（优先补进 five_hour），其余按 reset 升序
  unclassified.sort((left, right) => {
    const leftKey = left.resetMs === null ? Number.NEGATIVE_INFINITY : left.resetMs;
    const rightKey = right.resetMs === null ? Number.NEGATIVE_INFINITY : right.resetMs;
    return leftKey - rightKey;
  });
  for (const entry of unclassified) {
    if (fiveHour === null) {
      fiveHour = entry;
    } else if (weekly === null) {
      weekly = entry;
    }
    // 智谱当前最多两条 TOKENS_LIMIT，多余的忽略
  }
  const tiers: ProviderUsageTier[] = [];
  if (fiveHour) {
    tiers.push({
      id: "five_hour",
      usedPercentage: fiveHour.usedPercentage,
      resetsAt: fiveHour.resetsAt,
    });
  }
  if (weekly) {
    tiers.push({ id: "weekly", usedPercentage: weekly.usedPercentage, resetsAt: weekly.resetsAt });
  }
  return { ok: true, tiers };
}

function createZhipuAdapter(hostname: string): ProviderUsageAdapter {
  return {
    id: "zhipu",
    kind: "coding-plan",
    buildRequest: (_baseUrl, apiKey) => ({
      url: `${zhipuQuotaBase(hostname)}/api/monitor/usage/quota/limit`,
      headers: {
        // 智谱 monitor 接口不加 Bearer 前缀
        Authorization: apiKey,
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
      },
    }),
    parseResponse: parseZhipuUsageResponse,
  };
}

// ── Kimi For Coding ─────────────────────────────────────────
// GET https://api.kimi.com/coding/v1/usages；limits[].detail → 5 小时窗，顶层 usage → 周窗。

function kimiTierFromDetail(
  detail: Record<string, unknown>,
  id: ProviderUsageTier["id"],
): ProviderUsageTier | null {
  const limit = parseNumberField(detail, "limit");
  const remaining = parseNumberField(detail, "remaining");
  if (limit === undefined || remaining === undefined) return null;
  const usedPercentage = limit > 0 ? Math.max(0, ((limit - remaining) / limit) * 100) : undefined;
  return {
    id,
    usedPercentage,
    remaining,
    total: limit,
    used: Math.max(0, limit - remaining),
    resetsAt: epochToIso(detail.resetTime),
  };
}

function parseKimiUsageResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  const tiers: ProviderUsageTier[] = [];
  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const item of limits) {
    if (!isRecord(item) || !isRecord(item.detail)) continue;
    const tier = kimiTierFromDetail(item.detail, "five_hour");
    if (tier) tiers.push(tier);
  }
  if (isRecord(body.usage)) {
    const tier = kimiTierFromDetail(body.usage, "weekly");
    if (tier) tiers.push(tier);
  }
  return { ok: true, tiers };
}

function createKimiAdapter(): ProviderUsageAdapter {
  return {
    id: "kimi",
    kind: "coding-plan",
    buildRequest: (_baseUrl, apiKey) => ({
      url: "https://api.kimi.com/coding/v1/usages",
      headers: bearerHeaders(apiKey),
    }),
    parseResponse: parseKimiUsageResponse,
  };
}

// ── MiniMax ─────────────────────────────────────────────────
// GET https://api.minimaxi.com（cn）或 https://api.minimax.io/v1/api/openplatform/coding_plan/remains。
// 额度接口只在 minimaxi.com / minimax.io 有公开出处，api.minimax.cn 沿用旧域名（同一账号体系与 Key）。

function parseMinimaxUsageResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  // 业务级错误：base_resp.status_code ≠ 0
  if (isRecord(body.base_resp)) {
    const statusCode = parseNumberField(body.base_resp, "status_code");
    if (statusCode !== undefined && statusCode !== 0) {
      return {
        ok: false,
        message: `API error (code ${statusCode}): ${String(body.base_resp.status_msg ?? "unknown")}`,
      };
    }
  }
  const modelRemains = Array.isArray(body.model_remains) ? body.model_remains : [];
  // 只取 model_name == "general" 的条目，跳过 video 等非编程模型
  const item = modelRemains.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.model_name === "general",
  );
  if (!item) {
    return { ok: true, tiers: [] };
  }
  const tiers: ProviderUsageTier[] = [];
  // 5h 桶始终存在；接口直接给"剩余百分比"，反转为已用
  const intervalRemaining = parseNumberField(item, "current_interval_remaining_percent");
  if (intervalRemaining !== undefined) {
    tiers.push({
      id: "five_hour",
      usedPercentage: 100 - intervalRemaining,
      resetsAt: epochToIso(item.end_time),
    });
  }
  // 周桶仅 status==1 时激活；status==3 等表示该套餐无周限额，不展示
  if (parseNumberField(item, "current_weekly_status") === 1) {
    const weeklyRemaining = parseNumberField(item, "current_weekly_remaining_percent");
    if (weeklyRemaining !== undefined) {
      tiers.push({
        id: "weekly",
        usedPercentage: 100 - weeklyRemaining,
        resetsAt: epochToIso(item.weekly_end_time),
      });
    }
  }
  return { ok: true, tiers };
}

function createMinimaxAdapter(hostname: string): ProviderUsageAdapter {
  const apiDomain = hostname === "api.minimax.io" ? "api.minimax.io" : "api.minimaxi.com";
  return {
    id: "minimax",
    kind: "coding-plan",
    buildRequest: (_baseUrl, apiKey) => ({
      url: `https://${apiDomain}/v1/api/openplatform/coding_plan/remains`,
      headers: bearerHeaders(apiKey),
    }),
    parseResponse: parseMinimaxUsageResponse,
  };
}

// ── DeepSeek ────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance；balance_infos[] 实际只回一条 CNY。

function parseDeepSeekBalanceResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const info = infos.find((candidate): candidate is Record<string, unknown> => isRecord(candidate));
  if (!info) {
    return { ok: false, message: "响应缺少 balance_infos 字段" };
  }
  const remaining = parseNumberField(info, "total_balance");
  return {
    ok: true,
    tiers: [
      {
        id: "balance",
        remaining,
        unit: typeof info.currency === "string" ? info.currency : "CNY",
      },
    ],
  };
}

// ── SiliconFlow ─────────────────────────────────────────────
// GET https://api.siliconflow.{cn|com}/v1/user/info；data.totalBalance，cn 为 CNY、com 为 USD。

function parseSiliconFlowBalanceResponse(body: unknown, isCn: boolean): ProviderUsageParseOutcome {
  if (!isRecord(body) || !isRecord(body.data)) {
    return { ok: false, message: "响应缺少 data 字段" };
  }
  return {
    ok: true,
    tiers: [
      {
        id: "balance",
        remaining: parseNumberField(body.data, "totalBalance"),
        unit: isCn ? "CNY" : "USD",
      },
    ],
  };
}

// ── OpenRouter ──────────────────────────────────────────────
// GET https://openrouter.ai/api/v1/credits；remaining = total_credits − total_usage（USD）。

function parseOpenRouterBalanceResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  const data = isRecord(body.data) ? body.data : body;
  const total = parseNumberField(data, "total_credits");
  const used = parseNumberField(data, "total_usage");
  const remaining = total !== undefined && used !== undefined ? total - used : undefined;
  return {
    ok: true,
    tiers: [{ id: "balance", remaining, total, used, unit: "USD" }],
  };
}

// ── StepFun ─────────────────────────────────────────────────
// GET https://api.stepfun.com/v1/accounts；balance（CNY）。

function parseStepFunBalanceResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  return {
    ok: true,
    tiers: [{ id: "balance", remaining: parseNumberField(body, "balance"), unit: "CNY" }],
  };
}

// ── Novita AI ───────────────────────────────────────────────
// GET https://api.novita.ai/v3/user/balance；金额单位 0.0001 USD，需除以 10000。

function parseNovitaBalanceResponse(body: unknown): ProviderUsageParseOutcome {
  if (!isRecord(body)) {
    return { ok: false, message: "响应不是 JSON 对象" };
  }
  const available = parseNumberField(body, "availableBalance");
  return {
    ok: true,
    tiers: [
      {
        id: "balance",
        remaining: available === undefined ? undefined : available / 10000,
        unit: "USD",
      },
    ],
  };
}

// ── 适配器注册表 ────────────────────────────────────────────

/**
 * 按 base_url 的 hostname 装配适配器。hostname 必须已通过
 * detectProviderUsageAdapterId 精确匹配（调用方保证），此处不再做识别。
 */
export function resolveProviderUsageAdapter(
  adapterId: ProviderUsageAdapterId,
  baseUrl: string,
): ProviderUsageAdapter {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  switch (adapterId) {
    case "zhipu":
      return createZhipuAdapter(hostname);
    case "kimi":
      return createKimiAdapter();
    case "minimax":
      return createMinimaxAdapter(hostname);
    case "deepseek":
      return {
        id: "deepseek",
        kind: "balance",
        buildRequest: (_baseUrl, apiKey) => ({
          url: "https://api.deepseek.com/user/balance",
          headers: bearerHeaders(apiKey),
        }),
        parseResponse: parseDeepSeekBalanceResponse,
      };
    case "siliconflow":
      return {
        id: "siliconflow",
        kind: "balance",
        buildRequest: (_baseUrl, apiKey) => ({
          url:
            hostname === "api.siliconflow.com"
              ? "https://api.siliconflow.com/v1/user/info"
              : "https://api.siliconflow.cn/v1/user/info",
          headers: bearerHeaders(apiKey),
        }),
        parseResponse: (body) =>
          parseSiliconFlowBalanceResponse(body, hostname !== "api.siliconflow.com"),
      };
    case "openrouter":
      return {
        id: "openrouter",
        kind: "balance",
        buildRequest: (_baseUrl, apiKey) => ({
          url: "https://openrouter.ai/api/v1/credits",
          headers: bearerHeaders(apiKey),
        }),
        parseResponse: parseOpenRouterBalanceResponse,
      };
    case "stepfun":
      return {
        id: "stepfun",
        kind: "balance",
        buildRequest: (_baseUrl, apiKey) => ({
          url: "https://api.stepfun.com/v1/accounts",
          headers: bearerHeaders(apiKey),
        }),
        parseResponse: parseStepFunBalanceResponse,
      };
    case "novita":
      return {
        id: "novita",
        kind: "balance",
        buildRequest: (_baseUrl, apiKey) => ({
          url: "https://api.novita.ai/v3/user/balance",
          headers: bearerHeaders(apiKey),
        }),
        parseResponse: parseNovitaBalanceResponse,
      };
  }
}
