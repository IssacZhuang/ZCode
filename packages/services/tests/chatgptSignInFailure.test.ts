import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { MutableAccountProviderConfigSource } from "@zcode/provider";
import type { SharedZCodeCredentialStore, SiwcFetch } from "@zcode/provider-node";
import { createChatGptAccountService } from "../src/model-provider/chatgptAccountService.js";

function memoryStore() {
  const values = new Map<string, string>();
  const deleteIfValue = async (key: string, expected: string) => {
    if (values.get(key) !== expected) return false;
    return values.delete(key);
  };
  const store: SharedZCodeCredentialStore = {
    filePath: "synthetic-signin-test-store",
    load: async (key) => values.get(key) ?? null,
    loadMany: async (keys) => Object.fromEntries(keys.map((key) => [key, values.get(key) ?? null])),
    save: async (key, value) => {
      values.set(key, value);
    },
    saveMany: async (entries) => {
      for (const [key, value] of Object.entries(entries)) values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    deleteIfValue,
    deleteIfValues: async (entries) => {
      const results: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(entries))
        results[key] = await deleteIfValue(key, value);
      return results;
    },
    deleteManyIfValue: async (key, value, keys) => {
      if (values.get(key) !== value) return false;
      for (const entry of keys) values.delete(entry);
      return true;
    },
  };
  return { store, values };
}

async function callbackFixture(t: TestContext, fetchImpl: SiwcFetch) {
  const source = new MutableAccountProviderConfigSource();
  const initial = await source.read();
  const { store, values } = memoryStore();
  const service = createChatGptAccountService({
    accountSource: source,
    createCredentialStore: () => store,
    readConfigSnapshot: async () => {
      throw new Error("failed login must not publish an account");
    },
    fetch: fetchImpl,
  });
  const start = await service.startSignIn();
  t.after(() => service.cancelSignIn(start.transactionId));
  const authorize = new URL(start.authorizeUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  callback.searchParams.set("code", "synthetic-authorization-code");
  callback.searchParams.set("client_id", "oaiapp_synthetic_test");
  const response = await fetch(callback, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization successful/);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await service.pollSignIn(start.transactionId);
    if (result.status !== "pending") {
      assert.equal(await source.read(), initial);
      // 回调已收到不代表登录完成；失败只能保留安装 host-id，不能写入账号凭据。
      assert.deepEqual([...values.keys()], ["siwc:chatgpt:host-id"]);
      assert.deepEqual(await service.getStatus(), { signedIn: false, entitled: false });
      return result;
    }
    await delay(10);
  }
  assert.fail("sign-in failure did not settle");
}

test("callback acknowledgement followed by discovery 403 is a server error without token exchange", async (t) => {
  const requests: string[] = [];
  const result = await callbackFixture(t, async (input) => {
    requests.push(String(input));
    return new Response("synthetic forbidden response", { status: 403 });
  });
  assert.deepEqual(requests, ["https://auth.openai.com/.well-known/openid-configuration"]);
  assert.deepEqual(result, {
    status: "failed",
    reason: "server-error",
    message: "SIWC discovery returned 403",
  });
});

test("discovery connection failure remains a network error without account publication", async (t) => {
  const result = await callbackFixture(t, async () => {
    throw new TypeError("synthetic connection failure");
  });
  assert.deepEqual(result, {
    status: "failed",
    reason: "network",
    message: "SIWC discovery request failed",
  });
});
