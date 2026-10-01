import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { generateText, streamText } from "ai";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  createRegistryProviderConfig,
  parseAccountProviderConfigMap,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  type ProviderModel,
} from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createSiwcCompatFetch } from "../src/model/siwc-compat-fetch.js";

const MODEL_ID = "synthetic-model";
const FORBIDDEN_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];
const MESSAGES = [
  { role: "system" as const, content: "You are ZCode connectivity probe." },
  { role: "user" as const, content: "hi" },
];

function completedEventStream(modelId = MODEL_ID): Response {
  const message = {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const response = {
    id: "resp_synthetic",
    created_at: 1,
    model: modelId,
    status: "completed",
    output: [message],
    usage: { input_tokens: 2, output_tokens: 1 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, content: [] },
    },
    { type: "response.output_text.delta", item_id: message.id, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function builtinConfig() {
  return JSON.parse(
    await readFile(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
      "utf8",
    ),
  ) as {
    config: {
      providerConfigRules: unknown;
      modelConfigRules: {
        modelApiRules: Array<{
          modelMatch: string;
          apiTypeMatch: string;
          config: {
            optionSpecs?: {
              reasoningLevel: { map: string };
              maxOutputTokens: { map: string };
            };
          };
        }>;
      };
    };
  };
}

async function builtinOptionSpecs() {
  const builtin = await builtinConfig();
  const rule = builtin.config.modelConfigRules.modelApiRules.find(
    (entry) => entry.modelMatch === ".*" && entry.apiTypeMatch === "openai-responses",
  );
  assert.ok(rule?.config.optionSpecs);
  return rule.config.optionSpecs;
}

async function resolvedBuiltinModel(modelId: string): Promise<ProviderModel> {
  const builtin = await builtinConfig();
  const providers = parseZCodeBuiltinProviderConfigRules(builtin.config.providerConfigRules);
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: providers.providers,
    zcodeBuiltinProviderTemplates: providers.providerTemplates,
    zcodeBuiltinModelRules: parseZCodeBuiltinModelConfigRules(builtin.config.modelConfigRules),
    personalProviders: ProviderConfigMap.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: parseAccountProviderConfigMap({
      chatgpt: {
        builtinModelIds: [modelId],
        visibility: "visible",
        access: { type: "chatgpt-account", entitled: true },
      },
    }),
  });
  const model = resolution.registryProviders
    .find((provider) => provider.providerId === "chatgpt")
    ?.models.find((entry) => entry.modelId === modelId);
  assert.ok(model, "Resolved ChatGPT model must be executable");
  return model;
}

async function sdkFixture(account: boolean, maxOutputTokens: number, builtinModel?: ProviderModel) {
  const modelId = builtinModel?.modelId ?? MODEL_ID;
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const transport: typeof fetch = async (_input, init) => {
    assert.equal(typeof init?.body, "string");
    requests.push({
      body: JSON.parse(init!.body as string) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return completedEventStream(modelId);
  };
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: account ? "chatgpt-family" : "standard-personal",
      access: account
        ? { type: "chatgpt-account", entitled: true }
        : { type: "api-key", apiKey: "synthetic-api-key" },
      api: {
        type: "openai-responses",
        baseUrl: "https://provider.example.invalid/v1",
        headers: { "x-synthetic-header": "preserved" },
      },
    }),
  );
  assert.equal(provider.ok, true);
  if (!provider.ok) throw new Error("Synthetic provider config is incomplete");
  const bound = new AiSdkModelExecution({ env: {} }, { transport }).bindModel({
    providerId: account ? "chatgpt" : "synthetic-api-provider",
    modelId,
    providerConfig: provider.config,
    supportsJsonSchemaOutput: builtinModel?.config.properties.supportsJsonSchemaOutput ?? false,
    optionSpecs: builtinModel?.config.optionSpecs ?? (await builtinOptionSpecs()),
  });
  const resolved = bound.resolveRequest({
    options: {
      reasoningLevel: builtinModel?.config.optionSpecs.reasoningLevel.values[0] ?? "disabled",
      maxOutputTokens,
    },
    ...(account ? { requestAuth: { apiKey: "synthetic-access-token" } } : {}),
  });
  return { model: resolved.model, requests };
}

for (const maxOutputTokens of [1, 5000]) {
  for (const streaming of [true, false]) {
    test(`SIWC SDK ${streaming ? "stream" : "generate"} removes mapped budget ${maxOutputTokens} before transport`, async () => {
      const fixture = await sdkFixture(true, maxOutputTokens);
      const options = {
        model: fixture.model,
        messages: MESSAGES,
        maxOutputTokens,
        maxRetries: 0,
        allowSystemInMessages: true,
      };
      if (streaming) {
        const result = streamText(options);
        assert.equal(await result.text, "ok");
        assert.equal(await result.finishReason, "stop");
      } else {
        const result = await generateText(options);
        assert.equal(result.text, "ok");
        assert.equal(result.finishReason, "stop");
      }
      assert.equal(fixture.requests.length, 1);
      const { body, headers } = fixture.requests[0]!;
      for (const field of FORBIDDEN_FIELDS) assert.equal(Object.hasOwn(body, field), false, field);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.model, MODEL_ID);
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.deepEqual(body.input, [
        { role: "developer", content: MESSAGES[0]!.content },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ]);
      assert.equal(headers.get("authorization"), "Bearer synthetic-access-token");
      assert.equal(headers.get("x-synthetic-header"), "preserved");
    });
  }
}

test("ordinary API-key SDK probe keeps the mapped one-token budget", async () => {
  const fixture = await sdkFixture(false, 1);
  const result = streamText({
    model: fixture.model,
    messages: MESSAGES,
    maxOutputTokens: 1,
    maxRetries: 0,
    allowSystemInMessages: true,
  });
  assert.equal(await result.text, "ok");
  assert.equal(await result.finishReason, "stop");
  const { body, headers } = fixture.requests[0]!;
  assert.equal(body.max_output_tokens, 1);
  assert.equal(Object.hasOwn(body, "store"), false);
  assert.equal((body.input as Array<{ role: string }>)[0]!.role, "system");
  assert.equal(headers.get("authorization"), "Bearer synthetic-api-key");
});

test("built-in resolver exposes the supported minimum for GPT-6.1 Sol and preserves existing models", async () => {
  // 实测 GPT-6.1 Sol 拒绝 none；缺少能力规则会落入 disabled→none，探测必须读取公开的最低 low 档位。
  for (const modelId of ["gpt-6.1-sol", "gpt-6.1-sol-2026-10-01", "gpt-6-astra"]) {
    const model = await resolvedBuiltinModel(modelId);
    assert.deepEqual(model.config.optionSpecs.reasoningLevel.values, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    assert.equal(model.config.properties.contextWindow, 1_050_000);
    assert.equal(model.config.optionSpecs.maxOutputTokens.max, 128_000);
    assert.equal(model.config.properties.inputFormat.supportsImage, true);
    assert.equal(model.config.properties.inputFormat.supportsPdf, true);
    assert.equal(model.config.properties.supportsJsonSchemaOutput, true);
  }
  const existing = await resolvedBuiltinModel("gpt-5.6-sol");
  assert.equal(existing.config.optionSpecs.reasoningLevel.values[0], "none");
  const unknown = await resolvedBuiltinModel(MODEL_ID);
  assert.deepEqual(unknown.config.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
  assert.equal(unknown.config.properties.contextWindow, 200_000);
  assert.equal(unknown.config.optionSpecs.maxOutputTokens.max, 32_000);
});

test("SIWC SDK probe sends the minimum reasoning from the resolved GPT-6.1 Sol rules", async () => {
  const model = await resolvedBuiltinModel("gpt-6.1-sol");
  const fixture = await sdkFixture(true, 1, model);
  const result = streamText({
    model: fixture.model,
    messages: MESSAGES,
    maxOutputTokens: 1,
    maxRetries: 0,
    allowSystemInMessages: true,
  });
  assert.equal(await result.text, "ok");
  assert.equal(await result.finishReason, "stop");
  const { body } = fixture.requests[0]!;
  assert.equal(body.model, model.modelId);
  assert.deepEqual(body.reasoning, { effort: model.config.optionSpecs.reasoningLevel.values[0] });
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(Object.hasOwn(body, "max_output_tokens"), false);
});

test("SIWC final shape removes all unsupported fields and preserves supported body, headers and signal", async () => {
  const controller = new AbortController();
  const headers = {
    authorization: "Bearer synthetic-access-token",
    "x-synthetic-header": "preserved",
  };
  const body = {
    ...Object.fromEntries(FORBIDDEN_FIELDS.map((key) => [key, "synthetic-value"])),
    model: MODEL_ID,
    store: true,
    stream: true,
    instructions: "Synthetic instructions",
    reasoning: { effort: "low" },
    tools: [{ type: "function", name: "synthetic_tool", parameters: { type: "object" } }],
    input: [
      { role: "system", content: "Synthetic system prompt" },
      { role: "user", content: "hi" },
      { type: "function_call_output", call_id: "call_synthetic", output: "ok" },
    ],
  };
  const fetch = createSiwcCompatFetch(async (_input, init) => {
    const sent = JSON.parse(init!.body as string) as Record<string, unknown>;
    for (const field of FORBIDDEN_FIELDS) assert.equal(Object.hasOwn(sent, field), false, field);
    assert.deepEqual(sent, {
      model: body.model,
      store: false,
      stream: body.stream,
      instructions: body.instructions,
      reasoning: body.reasoning,
      tools: body.tools,
      input: [{ role: "developer", content: "Synthetic system prompt" }, ...body.input.slice(1)],
    });
    assert.equal(init?.headers, headers);
    assert.equal(init?.signal, controller.signal);
    return new Response(null, { status: 204 });
  });
  await fetch("https://provider.example.invalid/v1/responses", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
    signal: controller.signal,
  });
});
