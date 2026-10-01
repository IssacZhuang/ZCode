import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import {
  SIWC_DISCOVERY_URL,
  SiwcIdTokenVerificationError,
  SiwcOAuthError,
  fetchSiwcDiscovery,
  verifySiwcIdToken,
  type SiwcFetch,
} from "../src/siwc/siwc-oauth.js";

const OFFICIAL_ISSUER = "https://auth.openai.com";
const JWKS_URI = "https://example.invalid/test-jwks";
const CLIENT_ID = "synthetic-test-client";
const NONCE = "synthetic-test-nonce";

function discoveryFetch(issuer: string): SiwcFetch {
  return async (input) => {
    assert.equal(String(input), SIWC_DISCOVERY_URL);
    return Response.json({ issuer, jwks_uri: JWKS_URI });
  };
}

test("discovery accepts the official issuer without a trailing slash", async () => {
  const discovery = await fetchSiwcDiscovery(discoveryFetch(OFFICIAL_ISSUER));
  assert.deepEqual(discovery, { issuer: OFFICIAL_ISSUER, jwksUri: JWKS_URI });
});

test("discovery rejects an issuer with an extra trailing slash", async () => {
  await assert.rejects(
    fetchSiwcDiscovery(discoveryFetch(`${OFFICIAL_ISSUER}/`)),
    (error: unknown) =>
      error instanceof SiwcOAuthError &&
      error.oauthErrorCode === "invalid_response" &&
      error.message === "SIWC discovery returned an unexpected issuer",
  );
});

test("id_token verification retains signature and exact claim validation", async (t) => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const fetch: SiwcFetch = async (input) => {
    assert.equal(String(input), JWKS_URI);
    return Response.json({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] });
  };
  const baseClaims: JWTPayload = {
    iss: OFFICIAL_ISSUER,
    aud: CLIENT_ID,
    sub: "synthetic-test-subject",
    nonce: NONCE,
    exp: Math.floor(Date.now() / 1_000) + 300,
  };
  const sign = (claims: JWTPayload = {}, signingKey = privateKey) =>
    new SignJWT({ ...baseClaims, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(signingKey);
  const verify = (idToken: string) =>
    verifySiwcIdToken({
      discovery: { issuer: OFFICIAL_ISSUER, jwksUri: JWKS_URI },
      fetch,
      idToken,
      issuedClientId: CLIENT_ID,
      nonce: NONCE,
    });

  await t.test(
    "accepts a signed token with matching issuer, audience, nonce and expiry",
    async () => {
      const claims = await verify(await sign());
      assert.equal(claims.sub, baseClaims.sub);
    },
  );

  const rejectedClaims = [
    {
      name: "rejects a different issuer",
      claims: { iss: "https://example.invalid" },
      causeCode: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    },
    {
      name: "rejects a trailing slash in the signed issuer",
      claims: { iss: `${OFFICIAL_ISSUER}/` },
      causeCode: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    },
    {
      name: "rejects a different audience",
      claims: { aud: "synthetic-other-client" },
      causeCode: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    },
    {
      name: "rejects an expired token",
      claims: { exp: Math.floor(Date.now() / 1_000) - 60 },
      causeCode: "ERR_JWT_EXPIRED",
    },
  ];
  for (const scenario of rejectedClaims) {
    await t.test(scenario.name, async () => {
      await assert.rejects(verify(await sign(scenario.claims)), (error: unknown) => {
        assert.ok(error instanceof SiwcIdTokenVerificationError);
        assert.ok(error.cause instanceof Error && "code" in error.cause);
        assert.equal(error.cause.code, scenario.causeCode);
        return true;
      });
    });
  }

  await t.test("rejects a different nonce", async () => {
    await assert.rejects(
      verify(await sign({ nonce: "synthetic-other-nonce" })),
      (error: unknown) =>
        error instanceof SiwcIdTokenVerificationError &&
        error.message === "SIWC id_token nonce mismatch",
    );
  });

  await t.test("rejects a token signed by another key", async () => {
    const { privateKey: otherKey } = await generateKeyPair("RS256");
    await assert.rejects(verify(await sign({}, otherKey)), (error: unknown) => {
      assert.ok(error instanceof SiwcIdTokenVerificationError);
      assert.ok(error.cause instanceof Error && "code" in error.cause);
      assert.equal(error.cause.code, "ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
      return true;
    });
  });
});
