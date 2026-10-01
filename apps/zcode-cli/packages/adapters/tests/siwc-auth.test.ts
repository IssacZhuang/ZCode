import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { rootCertificates } from "node:tls";
import { test, type TestContext } from "node:test";
import { ProxyAgent } from "proxy-agent";
import {
  SIWC_DIRECT_TOKEN_SCOPE,
  SIWC_TOKEN_URL,
  buildSiwcCredentialRecord,
  createSharedZCodeCredentialStore,
  loadSiwcCredentialSnapshot,
  publishSiwcCredentialRecord,
} from "@zcode/provider-node";
import { createSiwcModelRequestAuthSource } from "../src/model/siwc-auth.js";

const REQUEST = { attempt: 1, providerId: "chatgpt", modelId: "synthetic-model" };
const PROXY_URL = "http://proxy.example.invalid:3128";
const TOKEN_RESPONSE = {
  access_token: "synthetic-refreshed-access",
  refresh_token: "synthetic-rotated-refresh",
  expires_in: 3600,
  scope: SIWC_DIRECT_TOKEN_SCOPE,
};

async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-siwc-auth-"));
  t.after(async () => {
    assert.ok(directory.startsWith(join(resolve(tmpdir()), "zcode-siwc-auth-")));
    await rm(directory, { recursive: true, force: true });
  });
  const store = createSharedZCodeCredentialStore({
    filePath: join(directory, "credentials.json"),
    cipher: { encrypt: (value) => value, decrypt: (value) => value },
  });
  await publishSiwcCredentialRecord(
    store,
    buildSiwcCredentialRecord({
      account: { sub: "synthetic-subject" },
      hostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
      issuedClientId: "oaiapp_synthetic_test",
      nowMs: Date.now() - 60_000,
      tokens: {
        accessToken: "synthetic-expired-access",
        refreshToken: "synthetic-refresh",
        expiresInSeconds: 1,
        scope: SIWC_DIRECT_TOKEN_SCOPE,
      },
    }),
  );
  return { directory, store };
}

function tokenResponse() {
  return new Response(JSON.stringify(TOKEN_RESPONSE), {
    headers: { "Content-Type": "application/json" },
  });
}

test("SIWC refresh uses the injected fetch and publishes the replacement credentials", async (t) => {
  const { store } = await createFixture(t);
  const fetch = t.mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), SIWC_TOKEN_URL);
    assert.equal(init?.method, "POST");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "synthetic-refresh");
    return tokenResponse();
  });
  const source = createSiwcModelRequestAuthSource({ createCredentialStore: () => store, fetch });
  assert.deepEqual(await source.resolve(REQUEST), { apiKey: TOKEN_RESPONSE.access_token });
  assert.equal(fetch.mock.callCount(), 1);
  const saved = await loadSiwcCredentialSnapshot(store);
  assert.equal(saved?.record.refreshToken, TOKEN_RESPONSE.refresh_token);
});

test("SIWC refresh uses the explicit agent proxy and CA without falling back to direct fetch", async (t) => {
  const { directory, store } = await createFixture(t);
  const caCertPath = join(directory, "ca.pem");
  await writeFile(caCertPath, rootCertificates[0], "utf8");
  const directFetch = t.mock.method(globalThis, "fetch", async () => tokenResponse());
  let proxyAgent: ProxyAgent | undefined;
  t.after(() => proxyAgent?.destroy());
  let requestBody: Buffer | undefined;
  const requestMock = t.mock.method(
    https,
    "request",
    (options: RequestOptions, callback?: (message: IncomingMessage) => void) => {
      assert.equal(options.hostname, "auth.openai.com");
      assert.equal(options.path, "/api/accounts/oauth/token");
      assert.equal(options.method, "POST");
      assert.ok(options.agent instanceof ProxyAgent);
      proxyAgent = options.agent;
      const request = new EventEmitter() as ClientRequest;
      request.end = (body?: unknown) => {
        requestBody = Buffer.isBuffer(body) ? body : undefined;
        const message = Readable.from([
          Buffer.from(JSON.stringify(TOKEN_RESPONSE)),
        ]) as IncomingMessage;
        message.statusCode = 200;
        message.statusMessage = "OK";
        message.headers = { "content-type": "application/json" };
        queueMicrotask(() => callback?.(message));
        return request;
      };
      return request;
    },
  );
  const source = createSiwcModelRequestAuthSource({
    createCredentialStore: () => store,
    env: { ZCODE_HTTP_PROXY: PROXY_URL, ZCODE_AGENT_CA_CERT: caCertPath },
  });
  assert.deepEqual(await source.resolve(REQUEST), { apiKey: TOKEN_RESPONSE.access_token });
  assert.equal(requestMock.mock.callCount(), 1);
  assert.equal(directFetch.mock.callCount(), 0);
  assert.ok(proxyAgent);
  assert.equal(
    await proxyAgent.getProxyForUrl(SIWC_TOKEN_URL, {} as ClientRequest),
    new URL(PROXY_URL).href,
  );
  assert.ok(proxyAgent.connectOpts && "ca" in proxyAgent.connectOpts);
  assert.ok(Buffer.isBuffer(proxyAgent.connectOpts.ca));
  assert.equal(proxyAgent.connectOpts.ca.toString(), rootCertificates[0]);
  assert.equal(new URLSearchParams(requestBody?.toString()).get("grant_type"), "refresh_token");
});

test("SIWC refresh honors No Proxy and ignores ambient shell proxy variables", async (t) => {
  for (const env of [
    { ZCODE_HTTP_PROXY: PROXY_URL, ZCODE_NO_PROXY: "auth.openai.com" },
    { HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL, ALL_PROXY: PROXY_URL },
  ]) {
    const { store } = await createFixture(t);
    const directFetch = t.mock.method(globalThis, "fetch", async () => tokenResponse());
    const source = createSiwcModelRequestAuthSource({ createCredentialStore: () => store, env });
    assert.deepEqual(await source.resolve(REQUEST), { apiKey: TOKEN_RESPONSE.access_token });
    assert.equal(directFetch.mock.callCount(), 1);
    directFetch.mock.restore();
  }
});
