import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSiwcModelIds } from "../src/siwc/siwc-models.js";
import { SiwcNetworkError, SiwcOAuthError } from "../src/siwc/siwc-oauth.js";

const ACCESS_TOKEN = "synthetic-test-token";

const readCatalog = (response: Response) =>
  fetchSiwcModelIds({ accessToken: ACCESS_TOKEN, fetch: async () => response });

const isInvalidResponse = (error: unknown) =>
  error instanceof SiwcOAuthError && error.oauthErrorCode === "invalid_response";

test("SIWC model catalog uses listed slugs and preserves server order", async () => {
  const modelIds = await fetchSiwcModelIds({
    accessToken: ACCESS_TOKEN,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/models");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${ACCESS_TOKEN}`);
      return Response.json({
        models: [
          { slug: "z-model", id: "wrong-api-key-id", display_name: "Z Model", visibility: "list" },
          { slug: "hidden-model", visibility: "hidden" },
          { slug: "unlisted-model" },
          { slug: "a-model", display_name: "A Model", visibility: "list" },
          { slug: "z-model", visibility: "list" },
          { id: "id-only-model", visibility: "list" },
          { slug: "", visibility: "list" },
          { slug: 42, visibility: "list" },
          null,
          42,
          [],
        ],
      });
    },
  });
  assert.deepEqual(modelIds, ["z-model", "a-model"]);
});

test("an empty SIWC models array is a valid catalog", async () => {
  assert.deepEqual(await readCatalog(Response.json({ models: [] })), []);
});

test("models without listed entries publish no model IDs", async () => {
  assert.deepEqual(
    await readCatalog(Response.json({ models: [{ slug: "hidden-model", visibility: "hidden" }] })),
    [],
  );
});

test("SIWC rejects malformed catalogs and does not accept API-key data/id shapes", async (t) => {
  const invalidCatalogs = [
    { name: "missing models", payload: {} },
    { name: "API-key data array", payload: { data: [{ id: "test-model" }] } },
    { name: "top-level array", payload: [{ slug: "test-model", visibility: "list" }] },
    { name: "models object", payload: { models: {} } },
    { name: "models null", payload: { models: null } },
    { name: "models string", payload: { models: "test-model" } },
    { name: "null body", payload: null },
  ];
  for (const scenario of invalidCatalogs) {
    await t.test(scenario.name, async () => {
      await assert.rejects(readCatalog(Response.json(scenario.payload)), isInvalidResponse);
    });
  }
});

test("invalid catalog JSON is a protocol response error", async () => {
  await assert.rejects(readCatalog(new Response("invalid-json")), isInvalidResponse);
});

test("an HTTP rejection retains its status and is not a network error", async () => {
  await assert.rejects(
    readCatalog(new Response("synthetic-forbidden-response", { status: 403 })),
    (error: unknown) => {
      assert.ok(error instanceof SiwcOAuthError);
      assert.equal(error.oauthErrorCode, "http_error");
      assert.equal(error.httpStatus, 403);
      assert.equal(error.message, "SIWC model catalog returned 403");
      return true;
    },
  );
});

test("a catalog connection failure remains a network error with its cause", async () => {
  const cause = new TypeError("synthetic-connection-failure");
  await assert.rejects(
    fetchSiwcModelIds({
      accessToken: ACCESS_TOKEN,
      fetch: async () => {
        throw cause;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof SiwcNetworkError);
      assert.equal(error.message, "SIWC model catalog request failed");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});
