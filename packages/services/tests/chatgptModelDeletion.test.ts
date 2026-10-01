import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ApiKeyAccessConfig,
  ChatgptAccountAccessConfig,
  ModelConfig,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
  createFailClosedAccountProviderConfigSnapshot,
  parseAccountProviderConfigMap,
  parsePersonalProviderConfigMap,
  parseProviderTemplateMap,
  parseZCodeBuiltinProviderConfigMap,
  type ProviderConfigLayerUpdate,
  type ProviderSettingsView,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  UnsupportedProviderConfigVersionError,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

const CHATGPT = "chatgpt";
const OFFICIAL = "test-chatgpt-official";
const DISABLED = "test-chatgpt-disabled";
const PERSONAL = "test-chatgpt-personal";
const NEW_MODEL = "test-chatgpt-new";
const API_PROVIDER = "test-api-provider";
const API_MODEL = "test-api-model";
const DEFAULT_SELECTION = {
  providerId: CHATGPT,
  modelId: OFFICIAL,
  options: { reasoningLevel: "enabled" },
};

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-chatgpt-deletion-"));
  const builtinFilePath = join(directory, "zcode-builtin.json");
  const personalFilePath = join(directory, "personal.json");
  await copyFile(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    builtinFilePath,
  );
  const initialConfig: ProviderConfigLayerUpdate = {
    providers: new ProviderConfigMap([
      [
        CHATGPT,
        new ProviderConfig({
          personalModelIds: [PERSONAL],
          modelOrder: [OFFICIAL, DISABLED, PERSONAL],
        }),
      ],
      [
        API_PROVIDER,
        new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "synthetic-test-key" }),
          api: new ProviderApiConfig({
            type: "openai-responses",
            baseUrl: "https://example.invalid/v1",
          }),
          personalModelIds: [API_MODEL],
        }),
      ],
    ]),
    models: ModelConfigRules.empty()
      .setExact(CHATGPT, OFFICIAL, ModelConfig.fromData({ properties: { contextWindow: 111_111 } }))
      .setExact(CHATGPT, DISABLED, new ModelConfig({ enabled: false }))
      .setExact(
        CHATGPT,
        PERSONAL,
        ModelConfig.fromData({ properties: { contextWindow: 222_222 } }),
      ),
    providerOrder: [CHATGPT, API_PROVIDER],
    defaultModelSelection: DEFAULT_SELECTION,
  };
  const v1File = { ...encodeProviderConfigFile(initialConfig), schemaVersion: 1 };
  await writeFile(personalFilePath, JSON.stringify(v1File), "utf8");
  const runtimes: ReturnType<typeof createProviderRuntime>[] = [];
  const repositories: NodePersonalProviderConfigRepository[] = [];
  t.after(async () => {
    for (const runtime of runtimes) runtime.dispose();
    for (const repository of repositories) repository.dispose();
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "zcode-chatgpt-deletion-")));
    await rm(directory, { recursive: true, force: true });
  });
  const createRepository = () => {
    const repository = new NodePersonalProviderConfigRepository({
      filePath: personalFilePath,
      pollingIntervalMs: false,
    });
    repositories.push(repository);
    return repository;
  };
  const createRuntime = async (
    modelIds: readonly string[] = [OFFICIAL, DISABLED],
    personalPollingIntervalMs: number | false = false,
  ) => {
    const source = new MutableAccountProviderConfigSource();
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath: builtinFilePath,
      personalFilePath,
      accountSource: source,
      watch: false,
      personalPollingIntervalMs,
    });
    runtimes.push(runtime);
    const publishDirectory = async (
      ids: readonly string[],
      connectionKey = "synthetic-account",
    ) => {
      const config = await runtime.configService.read();
      source.replace(
        createAccountProviderConfigSnapshot(
          config.zcodeBuiltinRevision,
          new ProviderConfigMap([
            [
              CHATGPT,
              new ProviderConfig({
                visibility: "visible",
                access: new ChatgptAccountAccessConfig({ entitled: true }),
                builtinModelIds: ids,
              }),
            ],
          ]),
          {
            [CHATGPT]: { availability: "available", entitled: true, current: true, connectionKey },
          },
        ),
        "test-directory",
      );
      await runtime.registryService.refresh("test-directory");
    };
    await runtime.start();
    await publishDirectory(modelIds);
    return { runtime, source, publishDirectory };
  };
  return {
    ...(await createRuntime()),
    createRuntime,
    createRepository,
    personalFilePath,
    initialConfig,
    v1File,
  };
}

function chatgpt(view: ProviderSettingsView) {
  const provider = view.providers.find((item) => item.providerId === CHATGPT);
  assert.ok(provider, "signed-in ChatGPT card must remain");
  return provider;
}

function modelIds(
  view: { providers: readonly { providerId: string; models: readonly { modelId: string }[] }[] },
  providerId = CHATGPT,
) {
  return (
    view.providers
      .find((provider) => provider.providerId === providerId)
      ?.models.map((model) => model.modelId) ?? []
  );
}

async function completes<T>(operation: Promise<T>): Promise<T> {
  // 仅限制测试事件等待，不为生产同步增加超时兜底。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Provider event did not arrive")), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("official deletion returns and emits authoritative views without changing the account directory", async (t) => {
  const { runtime, source, createRepository } = await createFixture(t);
  const account = await source.read();
  const before = await runtime.providerSettings.getView();
  assert.deepEqual(modelIds(before), [OFFICIAL, DISABLED, PERSONAL]);
  assert.ok(runtime.registryService.getModel(CHATGPT, OFFICIAL));
  const settingsEvents: ProviderSettingsView[] = [];
  const settingsSubscription = runtime.providerSettings.onDidChange((view) =>
    settingsEvents.push(view),
  );
  t.after(() => settingsSubscription.dispose());
  let selectionSubscription: { dispose(): void } | undefined;
  const selectionEvent = new Promise<void>((done) => {
    selectionSubscription = runtime.modelSelection.onDidChange((view) => {
      if (!modelIds(view).includes(OFFICIAL)) done();
    });
  });
  t.after(() => selectionSubscription?.dispose());
  const deleted = await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await completes(selectionEvent);
  assert.ok(deleted.revision > before.revision);
  assert.deepEqual(modelIds(deleted), [DISABLED, PERSONAL]);
  assert.ok(
    settingsEvents.some(
      (view) => view.revision === deleted.revision && !modelIds(view).includes(OFFICIAL),
    ),
  );
  assert.deepEqual(modelIds(await runtime.modelSelection.getView()), [PERSONAL]);
  assert.equal(runtime.registryService.getModel(CHATGPT, OFFICIAL), undefined);
  assert.deepEqual(await source.read(), account);
  const repository = createRepository();
  const personal = await repository.read();
  assert.deepEqual(personal.providers.get(CHATGPT)?.toJSON().excludedModelIds, [OFFICIAL]);
  assert.deepEqual(personal.providers.get(CHATGPT)?.modelOrder, [DISABLED, PERSONAL]);
  assert.deepEqual(personal.providers.get(CHATGPT)?.personalModelIds, [PERSONAL]);
  assert.equal(personal.models.getExactRule(CHATGPT, OFFICIAL), undefined);
  assert.deepEqual(personal.defaultModelSelection, DEFAULT_SELECTION);
  assert.deepEqual(modelIds(deleted, API_PROVIDER), [API_MODEL]);
  await assert.rejects(runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL), /不存在/);
  assert.equal((await repository.read()).revision, personal.revision);
});

test("official deletion creates a sparse Personal exclusion when no ChatGPT overlay exists", async (t) => {
  const { runtime, initialConfig, createRepository } = await createFixture(t);
  await runtime.configService.replacePersonalConfig({
    ...initialConfig,
    providers: initialConfig.providers.delete(CHATGPT),
    models: initialConfig.models.deleteExactForProvider(CHATGPT),
  });
  await runtime.registryService.refresh("test-no-personal-overlay");
  const before = chatgpt(await runtime.providerSettings.getView());
  assert.equal(before.personalConfig, undefined);
  assert.deepEqual(
    before.models.map((model) => model.modelId),
    [OFFICIAL, DISABLED],
  );
  const deleted = await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  assert.deepEqual(modelIds(deleted), [DISABLED]);
  assert.equal(runtime.registryService.getModel(CHATGPT, OFFICIAL), undefined);
  const personal = await createRepository().read();
  const overlay = personal.providers.get(CHATGPT);
  assert.ok(overlay);
  assert.deepEqual(overlay.toJSON().excludedModelIds, [OFFICIAL]);
  assert.deepEqual(overlay.personalModelIds ?? [], []);
  assert.deepEqual(overlay.modelOrder, [DISABLED]);
  assert.equal(overlay.access, undefined);
  assert.equal(overlay.api, undefined);
  assert.deepEqual(personal.defaultModelSelection, DEFAULT_SELECTION);
});

test("disabled and Personal deletion records every exclusion and permits an empty signed-in card", async (t) => {
  const { runtime, createRepository } = await createFixture(t);
  const initial = chatgpt(await runtime.providerSettings.getView());
  assert.equal(initial.models.find((model) => model.modelId === DISABLED)?.enabled, false);
  assert.equal(initial.models.find((model) => model.modelId === PERSONAL)?.builtin, false);
  for (const id of [DISABLED, PERSONAL, OFFICIAL]) {
    const view = await runtime.providerSettings.deletePersonalModel(CHATGPT, id);
    assert.ok(!modelIds(view).includes(id));
    assert.equal(runtime.registryService.getModel(CHATGPT, id), undefined);
  }
  const provider = chatgpt(await runtime.providerSettings.getView());
  assert.deepEqual(provider.models, []);
  assert.equal(provider.accountState?.entitled, true);
  assert.deepEqual(modelIds(await runtime.modelSelection.getView()), []);
  assert.deepEqual(modelIds(await runtime.modelSelection.getView(), API_PROVIDER), [API_MODEL]);
  const personal = await createRepository().read();
  assert.deepEqual(
    [...(personal.providers.get(CHATGPT)?.toJSON().excludedModelIds ?? [])].sort(),
    [DISABLED, OFFICIAL, PERSONAL].sort(),
  );
  assert.deepEqual(personal.providers.get(CHATGPT)?.personalModelIds, []);
  assert.deepEqual(personal.providers.get(CHATGPT)?.modelOrder, []);
  for (const id of [OFFICIAL, DISABLED, PERSONAL])
    assert.equal(personal.models.getExactRule(CHATGPT, id), undefined);
});

test("shared Repository reads, a second runtime and reconstruction retain exclusions across directory and account changes", async (t) => {
  const { runtime, createRuntime, createRepository, publishDirectory } = await createFixture(t);
  const second = await createRuntime();
  const repository = createRepository();
  const before = await repository.read();
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, PERSONAL);
  assert.notEqual((await repository.read()).revision, before.revision);
  // 关闭 watch/polling 后显式重读共享文件，不宣称跨进程原子下架。
  await second.runtime.registryService.refresh("test-shared-read");
  assert.deepEqual(modelIds(await second.runtime.providerSettings.getView()), [DISABLED]);
  await publishDirectory([OFFICIAL, DISABLED]);
  assert.deepEqual(modelIds(await runtime.providerSettings.refresh("test-same-directory")), [
    DISABLED,
  ]);
  runtime.dispose();
  const rebuilt = await createRuntime();
  assert.deepEqual(modelIds(await rebuilt.runtime.providerSettings.getView()), [DISABLED]);
  await rebuilt.publishDirectory([OFFICIAL, PERSONAL, DISABLED, NEW_MODEL]);
  assert.deepEqual(modelIds(await rebuilt.runtime.providerSettings.getView()), [
    NEW_MODEL,
    DISABLED,
  ]);
  rebuilt.source.replace(
    createFailClosedAccountProviderConfigSnapshot(await rebuilt.runtime.configService.read()),
    "test-sign-out",
  );
  await rebuilt.runtime.registryService.refresh("test-sign-out");
  assert.ok(
    !(await rebuilt.runtime.providerSettings.getView()).providers.some(
      (provider) => provider.providerId === CHATGPT,
    ),
  );
  await rebuilt.publishDirectory(
    [PERSONAL, OFFICIAL, DISABLED, NEW_MODEL],
    "synthetic-other-account",
  );
  assert.deepEqual(modelIds(await rebuilt.runtime.providerSettings.getView()), [
    NEW_MODEL,
    DISABLED,
  ]);
  assert.deepEqual(modelIds(await rebuilt.runtime.modelSelection.getView()), [NEW_MODEL]);
});

test("a second runtime automatically observes official deletion through shared-file polling", async (t) => {
  const { runtime, createRuntime } = await createFixture(t);
  const second = await createRuntime([OFFICIAL, DISABLED], 25);
  assert.ok(second.runtime.registryService.getModel(CHATGPT, OFFICIAL));
  assert.ok(modelIds(await second.runtime.modelSelection.getView()).includes(OFFICIAL));
  let subscription: { dispose(): void } | undefined;
  const observed = new Promise<void>((done) => {
    subscription = second.runtime.modelSelection.onDidChange((view) => {
      if (!modelIds(view).includes(OFFICIAL)) done();
    });
  });
  t.after(() => subscription?.dispose());
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await completes(observed);
  assert.equal(second.runtime.registryService.getModel(CHATGPT, OFFICIAL), undefined);
  assert.ok(second.runtime.registryService.getModel(CHATGPT, PERSONAL));
});

test("ordinary provider saves and reorder cannot resurrect models, while stale edits and enable operations are rejected", async (t) => {
  const { runtime, personalFilePath } = await createFixture(t);
  const oldView = await runtime.providerSettings.getView();
  const staleProvider = chatgpt(oldView).personalConfig;
  assert.ok(staleProvider);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, PERSONAL);
  await runtime.providerSettings.savePersonalProviderOverlay(CHATGPT, staleProvider, {
    providerName: "Renamed ChatGPT",
  });
  const reordered = await runtime.providerSettings.reorderPersonalModels(CHATGPT, [
    PERSONAL,
    OFFICIAL,
    DISABLED,
  ]);
  assert.deepEqual(modelIds(reordered), [DISABLED]);
  assert.deepEqual(chatgpt(reordered).personalConfig?.modelOrder, [DISABLED]);
  await runtime.providerSettings.setPersonalModelEnabled(CHATGPT, DISABLED, true);
  const current = await runtime.providerSettings.setPersonalModelEnabled(CHATGPT, DISABLED, false);
  const fileBeforeRejections = await readFile(personalFilePath, "utf8");
  for (const basedOnRevision of [oldView.revision, current.revision]) {
    await assert.rejects(
      runtime.providerSettings.savePersonalModelDraft({
        providerId: CHATGPT,
        originalModelId: OFFICIAL,
        nextModelId: OFFICIAL,
        personalConfig: { properties: { contextWindow: 999_999 } },
        basedOnRevision,
      }),
      basedOnRevision === oldView.revision ? /revision conflict/ : /不存在/,
    );
  }
  for (const id of [OFFICIAL, PERSONAL]) {
    for (const enabled of [true, false])
      await assert.rejects(
        runtime.providerSettings.setPersonalModelEnabled(CHATGPT, id, enabled),
        /不存在/,
      );
  }
  await assert.rejects(
    runtime.providerSettings.renamePersonalModel(CHATGPT, PERSONAL, NEW_MODEL),
    /不存在/,
  );
  assert.equal(await readFile(personalFilePath, "utf8"), fileBeforeRejections);
  assert.deepEqual(modelIds(await runtime.providerSettings.getView()), [DISABLED]);
});

test("deleted defaults use the existing new-draft fallback without silently replacing a fixed selection", async (t) => {
  const { runtime, createRepository } = await createFixture(t);
  assert.deepEqual((await runtime.modelSelection.getView()).preferredSelection, DEFAULT_SELECTION);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  const view = await runtime.modelSelection.getView({ selection: DEFAULT_SELECTION });
  assert.equal(view.effectiveSelection, null);
  assert.equal(view.selectionIssue, "model-not-found");
  assert.ok(view.preferredSelection);
  assert.notEqual(view.preferredSelection.modelId, OFFICIAL);
  assert.equal(runtime.registryService.validateSelection(DEFAULT_SELECTION).ok, false);
  assert.deepEqual((await createRepository().read()).defaultModelSelection, DEFAULT_SELECTION);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, PERSONAL);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, DISABLED);
  await runtime.providerSettings.deletePersonalModel(API_PROVIDER, API_MODEL);
  const empty = await runtime.modelSelection.getView({ selection: DEFAULT_SELECTION });
  assert.equal(empty.preferredSelection, undefined);
  assert.equal(empty.effectiveSelection, null);
  assert.deepEqual(empty.providers, []);
  assert.deepEqual(chatgpt(await runtime.providerSettings.getView()).models, []);
  assert.equal(runtime.registryService.validateSelection(DEFAULT_SELECTION).ok, false);
});

test("explicit add restores directory IDs as builtin and other IDs as Personal using only the new config", async (t) => {
  const { runtime, createRepository, personalFilePath, publishDirectory } = await createFixture(t);
  const inherited = chatgpt(await runtime.providerSettings.getView()).models.find(
    (model) => model.modelId === OFFICIAL,
  )?.effectiveBuiltinConfig;
  assert.ok(inherited);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, PERSONAL);
  const restored = await runtime.providerSettings.addPersonalModel(CHATGPT, OFFICIAL, {}, true);
  const official = chatgpt(restored).models.find((model) => model.modelId === OFFICIAL);
  assert.equal(official?.builtin, true);
  assert.deepEqual(official?.effectiveConfig, inherited);
  let personal = await createRepository().read();
  assert.ok(!personal.providers.get(CHATGPT)?.personalModelIds?.includes(OFFICIAL));
  assert.deepEqual(personal.providers.get(CHATGPT)?.toJSON().excludedModelIds, [PERSONAL]);
  const beforeDuplicate = await readFile(personalFilePath, "utf8");
  await assert.rejects(runtime.providerSettings.addPersonalModel(CHATGPT, OFFICIAL, {}), /已存在/);
  assert.equal(await readFile(personalFilePath, "utf8"), beforeDuplicate);
  const personalView = await runtime.providerSettings.addPersonalModel(
    CHATGPT,
    PERSONAL,
    { properties: { contextWindow: 333_333 } },
    true,
  );
  const personalModel = chatgpt(personalView).models.find((model) => model.modelId === PERSONAL);
  assert.equal(personalModel?.builtin, false);
  assert.equal(personalModel?.effectiveConfig.properties?.contextWindow, 333_333);
  await assert.rejects(runtime.providerSettings.addPersonalModel(CHATGPT, PERSONAL, {}), /已存在/);
  personal = await createRepository().read();
  assert.deepEqual(personal.providers.get(CHATGPT)?.toJSON().excludedModelIds ?? [], []);
  assert.equal(personal.models.getExact(CHATGPT, PERSONAL)?.properties?.contextWindow, 333_333);
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  await publishDirectory([DISABLED]);
  const beforeImplicitRestore = await readFile(personalFilePath, "utf8");
  await assert.rejects(runtime.providerSettings.renamePersonalModel(CHATGPT, PERSONAL, OFFICIAL));
  await assert.rejects(
    runtime.providerSettings.savePersonalModelDraft({
      providerId: CHATGPT,
      originalModelId: PERSONAL,
      nextModelId: OFFICIAL,
      personalConfig: {},
      basedOnRevision: (await runtime.providerSettings.getView()).revision,
    }),
  );
  assert.equal(await readFile(personalFilePath, "utf8"), beforeImplicitRestore);
  const outsideDirectory = await runtime.providerSettings.addPersonalModel(
    CHATGPT,
    OFFICIAL,
    { properties: { contextWindow: 444_444 } },
    true,
  );
  assert.equal(
    chatgpt(outsideDirectory).models.find((model) => model.modelId === OFFICIAL)?.builtin,
    false,
  );
  assert.equal(
    runtime.registryService.getModel(CHATGPT, OFFICIAL)?.config.properties.contextWindow,
    444_444,
  );
  await runtime.providerSettings.deletePersonalModel(CHATGPT, OFFICIAL);
  assert.ok(
    (await createRepository().read()).providers
      .get(CHATGPT)
      ?.toJSON()
      .excludedModelIds?.includes(OFFICIAL),
  );
});

test("other providers still reject inherited deletion and keep ordinary Personal deletion semantics", async (t) => {
  const { runtime, personalFilePath, createRepository } = await createFixture(t);
  const created = await runtime.providerSettings.createPersonalProvider({
    templateId: "openai",
    initialConfig: { access: { type: "api-key", apiKey: "synthetic-template-key" } },
  });
  const provider = created.view.providers.find((item) => item.providerId === created.providerId);
  const inherited = provider?.models.find((model) => model.builtin);
  assert.ok(inherited);
  const before = await readFile(personalFilePath, "utf8");
  await assert.rejects(
    runtime.providerSettings.deletePersonalModel(created.providerId, inherited.modelId),
    /Built-in Model 不能删除/,
  );
  assert.equal(await readFile(personalFilePath, "utf8"), before);
  await runtime.providerSettings.deletePersonalModel(API_PROVIDER, API_MODEL);
  assert.deepEqual(
    (await createRepository().read()).providers.get(API_PROVIDER)?.toJSON().excludedModelIds ?? [],
    [],
  );
});

test("the real Repository migrates v1 to v2 without dropping membership, order, rules or defaults", async (t) => {
  const { initialConfig, v1File, personalFilePath, createRepository } = await createFixture(t);
  const personal = await createRepository().read();
  assert.deepEqual(personal.providers.toJSON(), initialConfig.providers.toJSON());
  assert.deepEqual(personal.models.toPersonalJSON(), initialConfig.models.toPersonalJSON());
  assert.deepEqual(personal.providerOrder, initialConfig.providerOrder);
  assert.deepEqual(personal.defaultModelSelection, initialConfig.defaultModelSelection);
  const migrated = JSON.parse(await readFile(personalFilePath, "utf8")) as {
    schemaVersion: number;
    config: unknown;
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.config, v1File.config);
  assert.deepEqual(encodeProviderConfigFile(decodeProviderConfigFile(v1File)), migrated);
});

test("v2 codec round-trips Personal exclusions and rejects malformed exclusions", () => {
  const providers = parsePersonalProviderConfigMap({
    providerRules: [
      {
        providerId: CHATGPT,
        config: {
          personalModelIds: [PERSONAL],
          modelOrder: [PERSONAL],
          excludedModelIds: [OFFICIAL, DISABLED],
        },
      },
    ],
  });
  const encoded = encodeProviderConfigFile({
    providers,
    models: ModelConfigRules.empty(),
    defaultModelSelection: DEFAULT_SELECTION,
  });
  assert.equal(encoded.schemaVersion, 2);
  const decoded = decodeProviderConfigFile(encoded);
  assert.deepEqual(decoded.providers.get(CHATGPT)?.toJSON().excludedModelIds, [OFFICIAL, DISABLED]);
  assert.deepEqual(encodeProviderConfigFile(decoded), encoded);
  for (const excludedModelIds of ["not-an-array", [""], [42]]) {
    assert.throws(() =>
      decodeProviderConfigFile({
        ...encoded,
        config: {
          ...encoded.config,
          providerConfigRules: {
            providerRules: [{ providerId: CHATGPT, config: { excludedModelIds } }],
          },
        },
      }),
    );
  }
});

test("Built-in, template and account sources reject the Personal exclusion field", () => {
  assert.throws(() =>
    parseZCodeBuiltinProviderConfigMap([
      { providerId: CHATGPT, config: { group: "chatgpt-family", excludedModelIds: [OFFICIAL] } },
    ]),
  );
  assert.throws(() =>
    parseProviderTemplateMap([
      {
        templateId: CHATGPT,
        templateNameMap: { "en-US": "ChatGPT" },
        config: { excludedModelIds: [OFFICIAL] },
      },
    ]),
  );
  assert.throws(() =>
    parseAccountProviderConfigMap({
      [CHATGPT]: { builtinModelIds: [OFFICIAL], excludedModelIds: [OFFICIAL] },
    }),
  );
});

test("failed Repository transactions and unsupported versions leave the original file unchanged", async (t) => {
  const { createRepository, personalFilePath } = await createFixture(t);
  const repository = createRepository();
  const before = await readFile(personalFilePath, "utf8");
  await assert.rejects(
    repository.update((current) => ({
      ...current,
      providers: current.providers.set(
        CHATGPT,
        current.providers.get(CHATGPT)!.withPersonalModelIds([]),
      ),
      models: current.models
        .deleteExact(CHATGPT, PERSONAL)
        .setExact(CHATGPT, OFFICIAL, ModelConfig.fromData({ properties: { contextWindow: -1 } })),
    })),
  );
  assert.equal(await readFile(personalFilePath, "utf8"), before);
  const unsupported = JSON.stringify({
    schemaVersion: 99,
    config: { preserve: "synthetic-original" },
  });
  await writeFile(personalFilePath, unsupported, "utf8");
  assert.throws(
    () => decodeProviderConfigFile(JSON.parse(unsupported)),
    UnsupportedProviderConfigVersionError,
  );
  assert.deepEqual((await repository.read()).providers.toJSON(), []);
  await assert.rejects(
    repository.update((current) => current),
    UnsupportedProviderConfigVersionError,
  );
  assert.equal(await readFile(personalFilePath, "utf8"), unsupported);
});
