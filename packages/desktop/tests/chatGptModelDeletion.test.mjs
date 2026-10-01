import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import {
  ChatgptAccountAccessConfig,
  ModelConfig,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
} from "@zcode/provider";
import { encodeProviderConfigFile } from "@zcode/provider-node";
import { createProviderRuntime } from "@zcode/services/node";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempRoot = join(repoRoot, ".tmp");
const CHATGPT = "chatgpt";
const OFFICIAL = "fixture-chatgpt-official";
const DISABLED = "fixture-chatgpt-disabled";
const PERSONAL = "fixture-chatgpt-personal";
const OTHER = "fixture-api-provider";
const OTHER_MODEL = "fixture-api-builtin";
const FAILURE = "Synthetic deletion failure";
const manual = process.env.ZCODE_TEST_MANUAL === "1";
const fixtures = new Map();
const commands = [
  "getView",
  "resolveModelConfig",
  "savePersonalProviderOverlay",
  "addPersonalModel",
  "deletePersonalModel",
  "savePersonalModelDraft",
  "setPersonalModelEnabled",
  "reorderPersonalModels",
];
let fixtureRoot;
let server;
let browser;
let origin;

async function createRuntime(locale) {
  const directory = join(fixtureRoot, locale);
  await mkdir(directory);
  const builtinFilePath = join(directory, "builtin.json");
  const personalFilePath = join(directory, "personal.json");
  await copyFile(join(repoRoot, "config/provider/zcode-builtin.json"), builtinFilePath);
  const builtin = JSON.parse(await readFile(builtinFilePath, "utf8"));
  builtin.config.providerConfigRules.providerRules.push({
    providerId: OTHER,
    providerName: "Synthetic API provider",
    config: {
      group: "zai-family",
      access: { type: "api-key" },
      api: { type: "openai-responses", baseUrl: "https://example.invalid/v1" },
      builtinModelIds: [OTHER_MODEL],
    },
  });
  await writeFile(builtinFilePath, JSON.stringify(builtin));
  await writeFile(
    personalFilePath,
    JSON.stringify(
      encodeProviderConfigFile({
        providers: new ProviderConfigMap([
          [
            CHATGPT,
            new ProviderConfig({
              personalModelIds: [PERSONAL],
              modelOrder: [OFFICIAL, DISABLED, PERSONAL],
            }),
          ],
        ]),
        models: ModelConfigRules.empty().setExact(
          CHATGPT,
          DISABLED,
          new ModelConfig({ enabled: false }),
        ),
      }),
    ),
  );
  const source = new MutableAccountProviderConfigSource();
  const runtime = createProviderRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath,
    accountSource: source,
    watch: false,
    personalPollingIntervalMs: false,
    testConnectivity: async () => {
      throw new Error("Inference is forbidden in this fixture");
    },
  });
  const fixture = { runtime, source, calls: [], events: [], failNextDelete: true };
  fixtures.set(locale, fixture);
  await runtime.start();
  const config = await runtime.configService.read();
  const account = createAccountProviderConfigSnapshot(
    config.zcodeBuiltinRevision,
    new ProviderConfigMap([
      [
        CHATGPT,
        new ProviderConfig({
          visibility: "visible",
          access: new ChatgptAccountAccessConfig({ entitled: true }),
          builtinModelIds: [OFFICIAL, DISABLED],
        }),
      ],
    ]),
    { [CHATGPT]: { availability: "available", entitled: true, current: true } },
  );
  source.replace(account, "synthetic-browser-account");
  await runtime.registryService.refresh("synthetic-browser-account");
  fixture.account = await source.read();
  fixture.subscription = runtime.providerSettings.onDidChange((view) => fixture.events.push(view));
  return fixture;
}

before(async () => {
  await mkdir(tempRoot, { recursive: true });
  fixtureRoot = await mkdtemp(join(tempRoot, "chatgpt-model-deletion-"));
  await Promise.all([createRuntime("zh-CN"), createRuntime("en-US")]);
  await writeFile(
    join(fixtureRoot, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  );
  await writeFile(
    join(fixtureRoot, "main.tsx"),
    `import { createRoot } from "react-dom/client";
import "@/styles.css";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
const locale = new URLSearchParams(location.search).get("locale") ?? "zh-CN";
const providerSettingsService = Object.fromEntries(${JSON.stringify(commands)}.map(method => [method, async (...args) => {
  const response = await fetch("/fixture-api/" + locale, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.value;
}]));
// 此回归验证 Hook 提交 mutation 返回的权威 View，不依赖事件桥另造一份成员状态。
providerSettingsService.onDidChange = () => ({ dispose() {} });
const services = {
  providerSettingsService,
  chatGptAccountService: { getStatus: async () => ({ signedIn: true, entitled: true }) },
};
const platform = { openExternal() { throw new Error("External navigation is forbidden"); } };
function Fixture() {
  const models = useModelProviders({ workspacePath: "" });
  if (models.loadError) return <div role="alert">{models.loadError.message}</div>;
  return <main className="mx-auto max-w-3xl space-y-6 p-4">
    {models.modelProviders.map(provider => <section key={provider.providerId}
      data-testid={"fixture-" + provider.providerId} className="relative rounded-xl border border-border bg-card p-4">
      <ProviderDetailFeedbackBoundary>
        <InlineEditableProviderCard provider={provider} nameEditable={false} readOnlyEndpoints
          settingsRevision={models.providerSettingsView?.revision}
          onSave={models.saveProvider}
          onAddPersonalModel={models.addPersonalModel}
          onSavePersonalModelDraft={models.savePersonalModelDraft}
          onSetPersonalModelEnabled={models.setPersonalModelEnabled}
          onDeletePersonalModel={models.deletePersonalModel}
          onReorderModelIds={ids => models.reorderProviderModels(provider.providerId, ids)} />
      </ProviderDetailFeedbackBoundary>
    </section>)}
  </main>;
}
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={locale}><ServiceProvider services={services}>
    <PlatformProvider platform={platform}><TooltipProvider><Fixture /></TooltipProvider></PlatformProvider>
  </ServiceProvider></ZCodeIntlProvider>,
);`,
  );
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: "error",
    plugins: [
      tailwindcss(),
      {
        name: "synthetic-provider-runtime",
        configureServer(vite) {
          vite.middlewares.use("/fixture-api", (request, response) => {
            void (async () => {
              const fixture = fixtures.get(request.url?.slice(1));
              assert.ok(fixture, "Unknown fixture locale");
              assert.equal(request.method, "POST");
              let body = "";
              for await (const chunk of request) body += chunk;
              const { method, args } = JSON.parse(body);
              assert.ok(commands.includes(method), "Unknown provider service command");
              fixture.calls.push({ method, args });
              if (method === "deletePersonalModel" && fixture.failNextDelete) {
                fixture.failNextDelete = false;
                throw new Error(FAILURE);
              }
              const value = await fixture.runtime.providerSettings[method](...args);
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ value }));
            })().catch((error) => {
              response.statusCode = 500;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: error.message }));
            });
          });
        },
      },
    ],
    resolve: {
      alias: { "@": join(repoRoot, "packages/ui/src") },
      dedupe: ["react", "react-dom"],
    },
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repoRoot] } },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  if (manual) process.stdout.write(`ChatGPT deletion fixture: ${origin}?locale=zh-CN\n`);
  else
    browser = await chromium.launch({
      headless: true,
      channel: process.env.ZCODE_TEST_BROWSER_CHANNEL ?? "chrome",
    });
});

after(async () => {
  // 人工验收复用临时 Service；stdin 任意输入或 SIGINT 均走清理，兼容 Windows。
  if (manual) {
    await new Promise((done) => {
      process.stdin.resume();
      process.stdin.once("data", done);
      process.once("SIGINT", done);
    });
    process.stdin.pause();
  }
  await browser?.close();
  await server?.close();
  for (const fixture of fixtures.values()) {
    fixture.subscription?.dispose();
    fixture.runtime.dispose();
  }
  if (fixtureRoot?.startsWith(`${tempRoot}\\`) || fixtureRoot?.startsWith(`${tempRoot}/`)) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const cases = [
  {
    locale: "zh-CN",
    delete: "删除",
    edit: "编辑模型配置",
    retry: "重试",
    add: "添加模型",
    save: "保存",
    cancel: "取消",
    modelId: "模型 ID",
    signOut: "登出",
    empty: "当前没有配置模型，添加模型后可在聊天中使用。",
    failure: `ChatGPT / ${OFFICIAL} 删除失败：${FAILURE}`,
    success: (modelId) => `ChatGPT / ${modelId} 已删除`,
  },
  {
    locale: "en-US",
    delete: "Delete",
    edit: "Edit model settings",
    retry: "Retry",
    add: "Add model",
    save: "Save",
    cancel: "Cancel",
    modelId: "Model ID",
    signOut: "Sign out",
    empty: "No models are configured. Add a model to use it in chat.",
    failure: `Failed to delete ChatGPT / ${OFFICIAL}: ${FAILURE}`,
    success: (modelId) => `ChatGPT / ${modelId} deleted`,
  },
];

function chatgpt(view) {
  return view.providers.find((provider) => provider.providerId === CHATGPT);
}

for (const scenario of cases) {
  test(`${scenario.locale}: ChatGPT delete all sources, retry, empty account and restore`, async () => {
    if (manual) return;
    const fixture = fixtures.get(scenario.locale);
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const card = page.getByTestId(`fixture-${CHATGPT}`);
    const other = page.getByTestId(`fixture-${OTHER}`);
    const row = (modelId) => card.locator(`[data-model-provider-model-id="${modelId}"]`);
    try {
      await page.goto(`${origin}?locale=${scenario.locale}`);
      await card.getByText(OFFICIAL, { exact: true }).waitFor();
      await card.getByRole("button", { name: scenario.signOut, exact: true }).waitFor();
      const initial = chatgpt(await fixture.runtime.providerSettings.getView());
      assert.deepEqual(
        initial.models.map((m) => [m.modelId, m.builtin, m.enabled]),
        [
          [OFFICIAL, true, true],
          [DISABLED, true, false],
          [PERSONAL, false, true],
        ],
      );
      assert.equal(
        await other.getByRole("button", { name: scenario.delete, exact: true }).count(),
        0,
      );
      assert.equal(
        await card.getByRole("button", { name: scenario.delete, exact: true }).count(),
        3,
        "official, disabled and Personal ChatGPT rows must all offer Delete",
      );
      await row(OFFICIAL).getByRole("button", { name: scenario.edit, exact: true }).click();
      const dialog = page.getByRole("dialog");
      const idInput = dialog.getByPlaceholder(scenario.modelId, { exact: true });
      assert.notEqual(await idInput.getAttribute("readonly"), null, "builtin ID stays read-only");
      assert.equal(await idInput.inputValue(), OFFICIAL);
      await dialog.getByRole("button", { name: scenario.cancel, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });

      await row(OFFICIAL).getByRole("button", { name: scenario.delete, exact: true }).click();
      await card.getByRole("alert").getByText(scenario.failure, { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0, "delete must not open confirmation");
      assert.equal(
        await card.getByText(OFFICIAL, { exact: true }).count(),
        1,
        "failed deletion retains model",
      );
      await card.getByRole("button", { name: scenario.retry, exact: true }).click();
      await card.getByText(scenario.success(OFFICIAL), { exact: true }).waitFor();
      await card.getByText(OFFICIAL, { exact: true }).waitFor({ state: "hidden" });
      assert.equal(
        await fixture.source.read(),
        fixture.account,
        "deletion must not mutate account catalog",
      );
      assert.equal(
        chatgpt(fixture.runtime.registryService.getSnapshot().registry)?.models.some(
          (model) => model.modelId === OFFICIAL,
        ) ?? false,
        false,
      );
      assert.ok(
        fixture.events.some(
          (view) => !chatgpt(view)?.models.some((model) => model.modelId === OFFICIAL),
        ),
        "real service event removes the deleted ID",
      );
      for (const modelId of [DISABLED, PERSONAL]) {
        await row(modelId).getByRole("button", { name: scenario.delete, exact: true }).click();
        await card.getByText(scenario.success(modelId), { exact: true }).waitFor();
        await card.getByText(modelId, { exact: true }).waitFor({ state: "hidden" });
      }
      await card.getByText(scenario.empty, { exact: true }).waitFor();
      await card.getByRole("button", { name: scenario.signOut, exact: true }).waitFor();
      assert.equal(await card.getByText("ChatGPT", { exact: true }).count(), 1);
      assert.equal(await other.getByText(OTHER_MODEL, { exact: true }).count(), 1);
      assert.equal(chatgpt(await fixture.runtime.providerSettings.getView()).models.length, 0);
      assert.equal(chatgpt(await fixture.runtime.modelSelection.getView())?.models.length ?? 0, 0);
      await page.reload();
      await card.getByText(scenario.empty, { exact: true }).waitFor();
      await card.getByRole("button", { name: scenario.signOut, exact: true }).waitFor();

      await card.getByRole("button", { name: scenario.add, exact: true }).click();
      await dialog.getByPlaceholder(scenario.modelId, { exact: true }).fill(OFFICIAL);
      await dialog.getByRole("button", { name: scenario.save, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await card.getByText(OFFICIAL, { exact: true }).waitFor();
      const restored = chatgpt(await fixture.runtime.providerSettings.getView()).models;
      assert.deepEqual(
        restored.map((m) => [m.modelId, m.builtin]),
        [[OFFICIAL, true]],
      );
      assert.equal(
        await row(OFFICIAL).getByRole("button", { name: scenario.delete, exact: true }).count(),
        1,
      );
      assert.deepEqual(
        fixture.calls.filter((c) => c.method === "deletePersonalModel").map((c) => c.args),
        [
          [CHATGPT, OFFICIAL],
          [CHATGPT, OFFICIAL],
          [CHATGPT, DISABLED],
          [CHATGPT, PERSONAL],
        ],
        "failed delete retries once without cleanup writes or duplicate commands",
      );
      assert.equal(fixture.calls.filter((c) => c.method === "addPersonalModel").length, 1);
      assert.equal(
        fixture.calls.filter((c) => c.method === "savePersonalProviderOverlay").length,
        0,
      );
      assert.deepEqual(pageErrors, []);
    } finally {
      await page.close();
    }
  });
}
