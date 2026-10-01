import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ApiKeyAccessConfig,
  ChatgptAccountAccessConfig,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
  type ModelSelectionView,
  type ProviderConfigSnapshot,
} from "@zcode/provider";
import { encodeProviderConfigFile } from "@zcode/provider-node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

const API_PROVIDER_ID = "test-api-provider";
const API_MODEL_ID = "test-api-model";
const CHATGPT_MODEL_ID = "test-chatgpt-model";

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-provider-startup-"));
  const source = new MutableAccountProviderConfigSource();
  const builtinFilePath = join(directory, "zcode-builtin.json");
  const personalFilePath = join(directory, "personal.json");
  await copyFile(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    builtinFilePath,
  );
  await writeFile(
    personalFilePath,
    JSON.stringify(
      encodeProviderConfigFile({
        providers: new ProviderConfigMap([
          [
            API_PROVIDER_ID,
            new ProviderConfig({
              group: "standard-personal",
              access: new ApiKeyAccessConfig({ apiKey: "synthetic-test-key" }),
              api: new ProviderApiConfig({
                type: "openai-responses",
                baseUrl: "https://example.invalid/v1",
              }),
              personalModelIds: [API_MODEL_ID],
            }),
          ],
        ]),
        models: ModelConfigRules.empty(),
      }),
    ),
    "utf8",
  );
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath,
    accountSource: source,
    watch: false,
    personalPollingIntervalMs: false,
  });
  t.after(async () => {
    runtime.dispose();
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "zcode-provider-startup-")));
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, source };
}

function restoredAccount(config: ProviderConfigSnapshot) {
  return createAccountProviderConfigSnapshot(
    config.zcodeBuiltinRevision,
    new ProviderConfigMap([
      [
        "chatgpt",
        new ProviderConfig({
          visibility: "visible",
          access: new ChatgptAccountAccessConfig({ entitled: true }),
          builtinModelIds: [CHATGPT_MODEL_ID],
        }),
      ],
    ]),
    { chatgpt: { availability: "available", entitled: true, current: true } },
  );
}

async function completes<T>(operation: Promise<T>): Promise<T> {
  // 仅作为测试 watchdog：未初始化账号曾让启动 Promise 永久 pending，不给实现添加超时兜底。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Provider startup did not complete")), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("uninitialized account permits concurrent startup and API model reads", async (t) => {
  const { runtime, source } = await createFixture(t);
  const startup = runtime.start();
  assert.equal(runtime.start(), startup);
  const [, selection, settings] = await completes(
    Promise.all([startup, runtime.modelSelection.getView(), runtime.providerSettings.getView()]),
  );
  const account = await source.read();
  const config = await runtime.configService.read();
  assert.equal(account.basedOnZCodeBuiltinRevision, config.zcodeBuiltinRevision);
  const access = account.providers.get("chatgpt")?.access;
  assert.ok(access instanceof ChatgptAccountAccessConfig);
  assert.equal(access.entitled, false);
  assert.deepEqual(
    selection.providers
      .find((provider) => provider.providerId === API_PROVIDER_ID)
      ?.models.map((model) => model.modelId),
    [API_MODEL_ID],
  );
  assert.equal(
    settings.providers.find((provider) => provider.providerId === API_PROVIDER_ID)?.executable,
    true,
  );
  assert.equal(
    selection.providers.some((provider) => provider.providerId === "chatgpt"),
    false,
  );
  assert.equal(
    settings.providers.some((provider) => provider.providerId === "chatgpt"),
    false,
  );
});

test("startup preserves an account snapshot published before registry readiness", async (t) => {
  const { runtime, source } = await createFixture(t);
  const snapshot = restoredAccount(await runtime.configService.read());
  source.replace(snapshot, "test-preexisting-account");
  await completes(runtime.start());
  assert.equal((await source.read()).revision, snapshot.revision);
  const selection = await runtime.modelSelection.getView();
  assert.deepEqual(
    selection.providers
      .find((provider) => provider.providerId === "chatgpt")
      ?.models.map((model) => model.modelId),
    [CHATGPT_MODEL_ID],
  );
});

test("account restoration after startup publishes models through the existing event", async (t) => {
  const { runtime, source } = await createFixture(t);
  await completes(runtime.start());
  const initial = await runtime.modelSelection.getView();
  assert.equal(
    initial.providers.some((provider) => provider.providerId === "chatgpt"),
    false,
  );
  const restored = new Promise<ModelSelectionView>((resolveRestored) => {
    const subscription = runtime.modelSelection.onDidChange((view) => {
      if (
        view.providers.some(
          (provider) =>
            provider.providerId === "chatgpt" &&
            provider.models.some((model) => model.modelId === CHATGPT_MODEL_ID),
        )
      ) {
        resolveRestored(view);
      }
    });
    t.after(() => subscription.dispose());
  });
  source.replace(restoredAccount(await runtime.configService.read()), "test-restored-account");
  const view = await completes(restored);
  assert.ok(view.revision > initial.revision);
  const settings = await runtime.providerSettings.getView();
  assert.equal(
    settings.providers.find((provider) => provider.providerId === "chatgpt")?.executable,
    true,
  );
});
