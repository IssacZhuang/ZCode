import assert from "node:assert/strict";
import test from "node:test";
import { detectProviderUsageAdapterId } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/provider";
import { resolveProviderUsageAdapter } from "../src/model-provider/providerUsageAdapters.js";
import { createProviderUsageService } from "../src/model-provider/providerUsageService.js";

// 解析函数不单独导出：统一经适配器注册表取 parseResponse，避免出现仅测试消费的导出。
const zhipuParser = resolveProviderUsageAdapter(
  "zhipu",
  "https://open.bigmodel.cn/api/paas/v4",
).parseResponse;
const kimiParser = resolveProviderUsageAdapter("kimi", "https://api.kimi.com/coding").parseResponse;
const minimaxParser = resolveProviderUsageAdapter(
  "minimax",
  "https://api.minimaxi.com/v1",
).parseResponse;
const deepseekParser = resolveProviderUsageAdapter(
  "deepseek",
  "https://api.deepseek.com/v1",
).parseResponse;
const siliconflowCnParser = resolveProviderUsageAdapter(
  "siliconflow",
  "https://api.siliconflow.cn/v1",
).parseResponse;
const siliconflowEnParser = resolveProviderUsageAdapter(
  "siliconflow",
  "https://api.siliconflow.com/v1",
).parseResponse;
const openrouterParser = resolveProviderUsageAdapter(
  "openrouter",
  "https://openrouter.ai/api/v1",
).parseResponse;
const stepfunParser = resolveProviderUsageAdapter(
  "stepfun",
  "https://api.stepfun.ai/v1",
).parseResponse;
const novitaParser = resolveProviderUsageAdapter(
  "novita",
  "https://api.novita.ai/v3",
).parseResponse;

// ── 域名识别 ────────────────────────────────────────────────

test("detectProviderUsageAdapterId 命中全部内置域名", () => {
  assert.equal(detectProviderUsageAdapterId("https://open.bigmodel.cn/api/paas/v4"), "zhipu");
  assert.equal(detectProviderUsageAdapterId("https://bigmodel.cn/api/paas/v4"), "zhipu");
  assert.equal(detectProviderUsageAdapterId("https://api.z.ai/api/paas/v4"), "zhipu");
  assert.equal(detectProviderUsageAdapterId("https://api.kimi.com/coding"), "kimi");
  assert.equal(detectProviderUsageAdapterId("https://api.minimaxi.com/v1"), "minimax");
  assert.equal(detectProviderUsageAdapterId("https://api.minimax.cn/anthropic"), "minimax");
  assert.equal(detectProviderUsageAdapterId("https://api.minimax.io/v1"), "minimax");
  assert.equal(detectProviderUsageAdapterId("https://api.deepseek.com/v1"), "deepseek");
  assert.equal(detectProviderUsageAdapterId("https://api.siliconflow.cn/v1"), "siliconflow");
  assert.equal(detectProviderUsageAdapterId("https://api.siliconflow.com/v1"), "siliconflow");
  assert.equal(detectProviderUsageAdapterId("https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(detectProviderUsageAdapterId("https://api.stepfun.ai/v1"), "stepfun");
  assert.equal(detectProviderUsageAdapterId("https://api.novita.ai/v3"), "novita");
});

test("detectProviderUsageAdapterId 相似域名与非法输入不命中", () => {
  // 精确 host 匹配：cc-switch 同款反例，中转站伪装域名不得命中
  assert.equal(detectProviderUsageAdapterId("https://api.minimax.cn.example.com/v1"), null);
  assert.equal(detectProviderUsageAdapterId("https://open.bigmodel.cn.example.com/v1"), null);
  assert.equal(detectProviderUsageAdapterId("https://relay.example.com/v1"), null);
  assert.equal(detectProviderUsageAdapterId(""), null);
  assert.equal(detectProviderUsageAdapterId("not a url"), null);
  assert.equal(detectProviderUsageAdapterId("ftp://api.deepseek.com"), null);
});

// ── 智谱 GLM ────────────────────────────────────────────────

test("parseZhipuUsageResponse 新套餐双桶按 unit 分类", () => {
  const body = {
    success: true,
    data: {
      level: "PRO",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 40,
          nextResetTime: 1_760_000_000_000,
        },
        // 周窗口的重置时间早于 5h 窗口：按 unit 分类不受影响（cc-switch issue #3036）
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 7,
          percentage: 72,
          nextResetTime: 1_750_000_000_000,
        },
      ],
    },
  };
  const outcome = zhipuParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.tiers.length, 2);
  const [fiveHour, weekly] = outcome.tiers;
  assert.equal(fiveHour.id, "five_hour");
  assert.equal(fiveHour.usedPercentage, 40);
  assert.equal(fiveHour.resetsAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.usedPercentage, 72);
});

test("parseZhipuUsageResponse 老套餐单桶自然降级为 five_hour", () => {
  const body = {
    success: true,
    data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10 }] },
  };
  const outcome = zhipuParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.tiers.length, 1);
  assert.equal(outcome.tiers[0].id, "five_hour");
});

test("parseZhipuUsageResponse unit 缺失时无重置时间的条目优先归 five_hour", () => {
  const body = {
    data: {
      limits: [
        // 5 小时桶在 0% 等状态可能没有 nextResetTime
        { type: "TOKENS_LIMIT", percentage: 5 },
        { type: "TOKENS_LIMIT", percentage: 60, nextResetTime: 1_760_000_000_000 },
      ],
    },
  };
  const outcome = zhipuParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const [fiveHour, weekly] = outcome.tiers;
  assert.equal(fiveHour.id, "five_hour");
  assert.equal(fiveHour.usedPercentage, 5);
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.usedPercentage, 60);
});

test("parseZhipuUsageResponse 类型大小写不敏感并识别 CREDIT_LIMIT", () => {
  const body = {
    data: {
      limits: [
        { type: "Tokens_Limit", unit: 3, percentage: 20 },
        { type: "credit_limit", unit: 6, percentage: 50 },
      ],
    },
  };
  const outcome = zhipuParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.tiers.map((tier) => tier.id),
    ["five_hour", "weekly"],
  );
});

test("parseZhipuUsageResponse 业务错误与非法响应", () => {
  assert.equal(zhipuParser({ success: false, msg: "quota not found" }).ok, false);
  const missingData = zhipuParser({ success: true });
  assert.equal(missingData.ok, false);
  assert.equal(zhipuParser("not-an-object").ok, false);
});

// ── Kimi ────────────────────────────────────────────────────

test("parseKimiUsageResponse 5h 桶与周桶（resetTime 兼容秒级时间戳）", () => {
  const body = {
    limits: [{ detail: { limit: 1000, remaining: 250, resetTime: 1_760_000_000 } }],
    usage: { limit: 100_000, remaining: 80_000, resetTime: 1_761_000_000_000 },
  };
  const outcome = kimiParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const [fiveHour, weekly] = outcome.tiers;
  assert.equal(fiveHour.id, "five_hour");
  assert.equal(fiveHour.usedPercentage, 75);
  assert.equal(fiveHour.remaining, 250);
  assert.equal(fiveHour.total, 1000);
  assert.equal(fiveHour.resetsAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.usedPercentage, 20);
});

// ── MiniMax ─────────────────────────────────────────────────

test("parseMinimaxUsageResponse 剩余百分比反转为已用并跳过非 general 模型", () => {
  const body = {
    base_resp: { status_code: 0, status_msg: "success" },
    model_remains: [
      { model_name: "video", current_interval_remaining_percent: 90 },
      {
        model_name: "general",
        current_interval_remaining_percent: 30,
        end_time: 1_760_000_000_000,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 55.5,
        weekly_end_time: 1_761_000_000_000,
      },
    ],
  };
  const outcome = minimaxParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const [fiveHour, weekly] = outcome.tiers;
  assert.equal(fiveHour.id, "five_hour");
  assert.equal(fiveHour.usedPercentage, 70);
  assert.equal(weekly.id, "weekly");
  assert.equal(weekly.usedPercentage, 44.5);
});

test("parseMinimaxUsageResponse 无周限额套餐（status=3）只展示 5h", () => {
  const body = {
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 100,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
      },
    ],
  };
  const outcome = minimaxParser(body);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.tiers.length, 1);
  assert.equal(outcome.tiers[0].id, "five_hour");
  assert.equal(outcome.tiers[0].usedPercentage, 0);
});

test("parseMinimaxUsageResponse 业务错误", () => {
  const outcome = minimaxParser({
    base_resp: { status_code: 1004, status_msg: "invalid api key" },
  });
  assert.equal(outcome.ok, false);
});

// ── 余额类 ──────────────────────────────────────────────────

test("parseDeepSeekBalanceResponse 兼容字符串金额", () => {
  const outcome = deepseekParser({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00" }],
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const tier = outcome.tiers[0];
  assert.equal(tier.id, "balance");
  assert.equal(tier.remaining, 110);
  assert.equal(tier.unit, "CNY");
});

test("parseSiliconFlowBalanceResponse 按域名区分币种", () => {
  const body = { code: 20000, data: { balance: "1.5", totalBalance: "51.5" } };
  const cn = siliconflowCnParser(body);
  const en = siliconflowEnParser(body);
  assert.equal(cn.ok && cn.tiers[0].unit, "CNY");
  assert.equal(en.ok && en.tiers[0].unit, "USD");
  assert.equal(cn.ok && cn.tiers[0].remaining, 51.5);
});

test("parseOpenRouterBalanceResponse remaining = total_credits - total_usage", () => {
  const outcome = openrouterParser({
    data: { total_credits: 10, total_usage: 2.5 },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const tier = outcome.tiers[0];
  assert.equal(tier.remaining, 7.5);
  assert.equal(tier.total, 10);
  assert.equal(tier.used, 2.5);
  assert.equal(tier.unit, "USD");
});

test("parseStepFunBalanceResponse 与 parseNovitaBalanceResponse（÷10000 换算）", () => {
  const stepfun = stepfunParser({ object: "account", balance: 88.5 });
  assert.equal(stepfun.ok && stepfun.tiers[0].remaining, 88.5);
  assert.equal(stepfun.ok && stepfun.tiers[0].unit, "CNY");
  const novita = novitaParser({ availableBalance: 250_000 });
  // Novita 金额单位 0.0001 USD
  assert.equal(novita.ok && novita.tiers[0].remaining, 25);
  assert.equal(novita.ok && novita.tiers[0].unit, "USD");
});

// ── 适配器请求构造 ──────────────────────────────────────────

test("resolveProviderUsageAdapter 智谱不加 Bearer 且按域名路由额度端点", () => {
  const cn = resolveProviderUsageAdapter("zhipu", "https://open.bigmodel.cn/api/paas/v4");
  const cnPlan = cn.buildRequest("https://open.bigmodel.cn/api/paas/v4", "sk-test");
  assert.equal(cnPlan.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(cnPlan.headers.Authorization, "sk-test");

  const en = resolveProviderUsageAdapter("zhipu", "https://api.z.ai/api/paas/v4");
  const enPlan = en.buildRequest("https://api.z.ai/api/paas/v4", "sk-test");
  assert.equal(enPlan.url, "https://api.z.ai/api/monitor/usage/quota/limit");
});

test("resolveProviderUsageAdapter minimax cn 固定走 minimaxi.com 域", () => {
  const cn = resolveProviderUsageAdapter("minimax", "https://api.minimax.cn/anthropic");
  assert.equal(
    cn.buildRequest("https://api.minimax.cn/anthropic", "test").url,
    "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
  );
  const io = resolveProviderUsageAdapter("minimax", "https://api.minimax.io/v1");
  assert.equal(
    io.buildRequest("https://api.minimax.io/v1", "test").url,
    "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  );
});

// ── 服务装配（注入 fake fetchImpl）──────────────────────────

function buildFakeView(
  providers: Array<{
    providerId: string;
    baseUrl?: string;
    apiKey?: string | null;
  }>,
): ProviderSettingsView {
  return {
    revision: 1,
    providerTemplates: [],
    providerOrder: providers.map((item) => item.providerId),
    providers: providers.map((item) => ({
      providerId: item.providerId,
      enabled: true,
      executable: true,
      issues: [],
      models: [],
      effectiveConfig: {
        api: item.baseUrl ? { type: "openai-chat-completions", baseUrl: item.baseUrl } : null,
        access: item.apiKey === undefined ? null : { type: "api-key", apiKey: item.apiKey },
      },
    })),
  } as unknown as ProviderSettingsView;
}

function buildService(
  view: ProviderSettingsView,
  fetchImpl: typeof fetch,
): ReturnType<typeof createProviderUsageService> {
  return createProviderUsageService({
    getView: async () => view,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
}

test("getProviderUsage 未识别域名返回 unsupported 且不发请求", async () => {
  let fetched = 0;
  const service = buildService(
    buildFakeView([
      { providerId: "custom-relay", baseUrl: "https://relay.example.com/v1", apiKey: "k" },
    ]),
    () => {
      fetched += 1;
      throw new Error("should not fetch");
    },
  );
  const snapshot = await service.getProviderUsage("custom-relay");
  assert.equal(snapshot.error?.code, "unsupported");
  assert.equal(fetched, 0);
});

test("getProviderUsage 缺少 key 返回 missing-api-key 且不发请求", async () => {
  let fetched = 0;
  const service = buildService(
    buildFakeView([{ providerId: "p1", baseUrl: "https://api.deepseek.com/v1", apiKey: "" }]),
    () => {
      fetched += 1;
      throw new Error("should not fetch");
    },
  );
  const snapshot = await service.getProviderUsage("p1");
  assert.equal(snapshot.error?.code, "missing-api-key");
  assert.equal(fetched, 0);
});

test("getProviderUsage 401 标记 credentialValid=false", async () => {
  const service = buildService(
    buildFakeView([{ providerId: "p1", baseUrl: "https://api.deepseek.com/v1", apiKey: "bad" }]),
    (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
  );
  const snapshot = await service.getProviderUsage("p1");
  assert.equal(snapshot.error?.code, "auth-failed");
  assert.equal(snapshot.credentialValid, false);
  assert.equal(snapshot.adapterId, "deepseek");
});

test("getProviderUsage 成功路径产出 tiers", async () => {
  const service = buildService(
    buildFakeView([
      { providerId: "p1", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "k" },
    ]),
    (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, percentage: 40, nextResetTime: 1_760_000_000_000 },
              { type: "TOKENS_LIMIT", unit: 6, percentage: 10 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch,
  );
  const snapshot = await service.getProviderUsage("p1");
  assert.equal(snapshot.error, undefined);
  assert.equal(snapshot.kind, "coding-plan");
  assert.equal(snapshot.tiers.length, 2);
  assert.equal(snapshot.credentialValid, true);
  assert.equal(snapshot.queriedAt, 1_700_000_000_000);
});

test("getProviderUsage 传输失败归为 network 可重试", async () => {
  const service = buildService(
    buildFakeView([{ providerId: "p1", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" }]),
    (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  );
  const snapshot = await service.getProviderUsage("p1");
  assert.equal(snapshot.error?.code, "network");
});
