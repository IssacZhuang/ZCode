import assert from "node:assert/strict";
import { createHash, generateKeyPair, sign, type KeyObject } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  ChatgptAccountAccessConfig,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  ProviderConfigMap,
  type ModelSelectionView,
} from "@zcode/provider";
import {
  SIWC_DISCOVERY_URL,
  SIWC_ISSUER,
  SIWC_RESOURCE,
  SIWC_SCOPE,
  SIWC_TOKEN_URL,
  createSharedZCodeCredentialStore,
  encodeProviderConfigFile,
  loadSiwcCredentialSnapshot,
  type SiwcFetch,
} from "@zcode/provider-node";
import { zcodeProviderUpdateAccountConfigParamsSchema } from "@zcode/shared";
import {
  createChatGptAccountService,
  type ChatGptSignInPollResult,
} from "../src/model-provider/chatgptAccountService.js";
import {
  createProviderRuntime,
  type ProviderRuntime,
} from "../src/model-provider/providerRuntime.js";

const CLIENT_ID = "oaiapp_synthetic_test";
const JWKS_URI = "https://auth.openai.com/.well-known/jwks.json";
const MODEL_IDS = ["z-synthetic-model", "a-synthetic-model"];
const ACCOUNT = {
  email: "synthetic@example.invalid",
  name: "Synthetic account",
  planType: "plus",
};

async function signingKeys() {
  return new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((resolveKeys, reject) => {
    generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey) => {
      if (error) reject(error);
      else resolveKeys({ publicKey, privateKey });
    });
  });
}

async function completes<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sign-in publication did not complete")), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createFixture(
  t: TestContext,
  modelsResponse: () => Promise<Response> = async () =>
    Response.json({
      models: [
        { slug: MODEL_IDS[0], display_name: "Synthetic Z", visibility: "list" },
        { slug: "hidden-synthetic-model", display_name: "Hidden", visibility: "hide" },
        { slug: MODEL_IDS[1], display_name: "Synthetic A", visibility: "list" },
      ],
    }),
) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-chatgpt-signin-"));
  let runtime: ProviderRuntime | undefined;
  t.after(async () => {
    runtime?.dispose();
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "zcode-chatgpt-signin-")));
    await rm(directory, { recursive: true, force: true });
  });
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
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
      }),
    ),
    "utf8",
  );
  const source = new MutableAccountProviderConfigSource();
  const providerRuntime = createProviderRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath,
    accountSource: source,
    watch: false,
    personalPollingIntervalMs: false,
  });
  runtime = providerRuntime;
  await completes(providerRuntime.start());
  const initial = await source.read();
  const store = createSharedZCodeCredentialStore({
    filePath: join(directory, "credentials.json"),
    cipher: { encrypt: (value) => value, decrypt: (value) => value },
  });
  const keys = await signingKeys();
  let authorize: URL | undefined;
  const requests: string[] = [];
  const envelopes: unknown[] = [];
  const fetchImpl: SiwcFetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url === SIWC_DISCOVERY_URL) {
      return Response.json({ issuer: SIWC_ISSUER, jwks_uri: JWKS_URI });
    }
    if (url === SIWC_TOKEN_URL) {
      assert.ok(authorize);
      assert.equal(init?.method, "POST");
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("client_id"), CLIENT_ID);
      assert.equal(body.get("code"), "synthetic-authorization-code");
      assert.equal(body.get("redirect_uri"), authorize.searchParams.get("redirect_uri"));
      assert.equal(body.get("resource"), SIWC_RESOURCE);
      assert.equal(
        createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
        authorize.searchParams.get("code_challenge"),
      );
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-key" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          iss: SIWC_ISSUER,
          aud: CLIENT_ID,
          sub: "synthetic-subject",
          exp: Math.floor(Date.now() / 1_000) + 3_600,
          nonce: authorize.searchParams.get("nonce"),
          email: ACCOUNT.email,
          name: ACCOUNT.name,
          "https://api.openai.com/auth": { chatgpt_plan_type: ACCOUNT.planType },
        }),
      ).toString("base64url");
      const signed = `${header}.${payload}`;
      const signature = sign("RSA-SHA256", Buffer.from(signed), keys.privateKey).toString(
        "base64url",
      );
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        id_token: `${signed}.${signature}`,
        expires_in: 3_600,
        scope: SIWC_SCOPE,
      });
    }
    if (url === JWKS_URI) {
      return Response.json({
        keys: [{ ...keys.publicKey.export({ format: "jwk" }), alg: "RS256", kid: "synthetic-key" }],
      });
    }
    assert.equal(url, `${SIWC_RESOURCE}/models`);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-access");
    assert.equal(init?.credentials, "omit");
    // 浏览器回调成功只表示收到授权码；目录验证完成前不能发布凭据或账号投影。
    assert.equal(await loadSiwcCredentialSnapshot(store), undefined);
    assert.equal(await source.read(), initial);
    assert.equal(envelopes.length, 0);
    return modelsResponse();
  };
  const service = createChatGptAccountService({
    accountSource: source,
    createCredentialStore: () => store,
    readConfigSnapshot: () => providerRuntime.configService.read(),
    fetch: fetchImpl,
    getSyncProviderAccountConfig: () => async (envelope) => {
      envelopes.push(envelope);
    },
  });
  const completeSignIn = async (): Promise<ChatGptSignInPollResult> => {
    const start = await service.startSignIn();
    t.after(() => service.cancelSignIn(start.transactionId));
    authorize = new URL(start.authorizeUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-authorization-code");
    callback.searchParams.set("client_id", CLIENT_ID);
    const response = await fetch(callback, { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Authorization successful/);
    return completes(
      (async () => {
        for (;;) {
          const result = await service.pollSignIn(start.transactionId);
          if (result.status !== "pending") return result;
          await delay(10);
        }
      })(),
    );
  };
  return {
    runtime: providerRuntime,
    source,
    initial,
    store,
    service,
    requests,
    envelopes,
    completeSignIn,
  };
}

test("SIWC callback, verified tokens and official model catalog publish an executable account", async (t) => {
  const fixture = await createFixture(t);
  const published = new Promise<ModelSelectionView>((resolvePublished) => {
    const subscription = fixture.runtime.modelSelection.onDidChange((view) => {
      if (view.providers.some((provider) => provider.providerId === "chatgpt"))
        resolvePublished(view);
    });
    t.after(() => subscription.dispose());
  });
  assert.deepEqual(await fixture.completeSignIn(), {
    status: "completed",
    entitled: true,
    account: ACCOUNT,
  });
  assert.deepEqual(fixture.requests, [
    SIWC_DISCOVERY_URL,
    SIWC_TOKEN_URL,
    JWKS_URI,
    `${SIWC_RESOURCE}/models`,
  ]);
  assert.deepEqual(await fixture.service.getStatus(), {
    signedIn: true,
    entitled: true,
    account: ACCOUNT,
  });
  const saved = await loadSiwcCredentialSnapshot(fixture.store);
  assert.ok(saved);
  assert.deepEqual(saved.record.modelIds, MODEL_IDS);
  assert.equal(saved.record.scope, SIWC_SCOPE);
  const account = await fixture.source.read();
  const config = await fixture.runtime.configService.read();
  assert.equal(account.basedOnZCodeBuiltinRevision, config.zcodeBuiltinRevision);
  const provider = account.providers.get("chatgpt");
  assert.ok(provider?.access instanceof ChatgptAccountAccessConfig);
  assert.equal(provider.access.entitled, true);
  assert.equal(provider.visibility, "visible");
  assert.deepEqual(provider.builtinModelIds, MODEL_IDS);
  assert.deepEqual(account.states?.chatgpt, {
    availability: "available",
    entitled: true,
    current: true,
    connectionKey: "synthetic-subject",
  });
  assert.equal(fixture.envelopes.length, 1);
  const envelope = zcodeProviderUpdateAccountConfigParamsSchema.parse(fixture.envelopes[0]);
  assert.equal(envelope.revision, account.revision);
  assert.deepEqual(envelope.providers.chatgpt, provider.toJSON());
  assert.deepEqual(envelope.states, account.states);
  const selection = await completes(published);
  assert.deepEqual(
    selection.providers
      .find((entry) => entry.providerId === "chatgpt")
      ?.models.map((model) => model.modelId),
    MODEL_IDS,
  );
  const settings = await fixture.runtime.providerSettings.getView();
  const configured = settings.providers.find((entry) => entry.providerId === "chatgpt");
  assert.ok(configured?.executable);
  assert.deepEqual(
    configured.models.map((model) => model.modelId),
    MODEL_IDS,
  );
  assert.ok(configured.models.every((model) => model.executable && model.selectable));
});

for (const scenario of [
  {
    name: "invalid model catalog",
    reason: "protocol",
    response: async () => Response.json({ models: {} }),
  },
  {
    name: "model catalog HTTP 403",
    reason: "server-error",
    response: async () => new Response("", { status: 403 }),
  },
  {
    name: "model catalog connection failure",
    reason: "network",
    response: async (): Promise<Response> => {
      throw new TypeError("synthetic model connection failure");
    },
  },
] as const) {
  test(`SIWC ${scenario.name} fails after verification without publishing an account`, async (t) => {
    const fixture = await createFixture(t, scenario.response);
    const result = await fixture.completeSignIn();
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed");
    assert.equal(result.reason, scenario.reason);
    assert.match(result.message ?? "", /SIWC model catalog/);
    assert.deepEqual(fixture.requests, [
      SIWC_DISCOVERY_URL,
      SIWC_TOKEN_URL,
      JWKS_URI,
      `${SIWC_RESOURCE}/models`,
    ]);
    assert.equal(await loadSiwcCredentialSnapshot(fixture.store), undefined);
    assert.equal(await fixture.source.read(), fixture.initial);
    assert.deepEqual(fixture.envelopes, []);
    assert.deepEqual(await fixture.service.getStatus(), { signedIn: false, entitled: false });
    const [selection, settings] = await Promise.all([
      fixture.runtime.modelSelection.getView(),
      fixture.runtime.providerSettings.getView(),
    ]);
    assert.equal(
      selection.providers.some((entry) => entry.providerId === "chatgpt"),
      false,
    );
    assert.equal(
      settings.providers.some((entry) => entry.providerId === "chatgpt"),
      false,
    );
  });
}
