import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelRequestSessionType,
  type ModelRequestSessionType as ModelRequestSessionTypeValue,
} from "@zcode/contracts";
import { createSiwcCacheAffinityHeaders } from "../src/model/runner-status.js";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

type AffinityInput = Parameters<typeof createSiwcCacheAffinityHeaders>[0];

function affinityInput(input: {
  sessionId?: string;
  parentSessionId?: string;
  modelRequestSessionType: ModelRequestSessionTypeValue;
}): AffinityInput {
  return input as AffinityInput;
}

test("main/other session derives cache affinity from its own normalized session id", () => {
  for (const sessionType of [ModelRequestSessionType.Main, ModelRequestSessionType.Other]) {
    assert.deepEqual(
      createSiwcCacheAffinityHeaders(
        affinityInput({ sessionId: "sess_main-session-1", modelRequestSessionType: sessionType }),
      ),
      { "session-id": "main-session-1" },
      sessionType,
    );
  }
});

test("subagent session inherits the parent-derived affinity key and reports thread id", () => {
  assert.deepEqual(
    createSiwcCacheAffinityHeaders(
      affinityInput({
        // 子会话自身的实现前缀不得进入亲和 key；父会话的 sess_ 前缀同样剥离。
        sessionId: "subagent_agent_child-7",
        parentSessionId: "sess_parent-9",
        modelRequestSessionType: ModelRequestSessionType.Subagent,
      }),
    ),
    { "session-id": "subagent:parent-9", "thread-id": "parent-9" },
  );
});

test("subagent without a parent session falls back to its own session id without thread id", () => {
  assert.deepEqual(
    createSiwcCacheAffinityHeaders(
      affinityInput({
        sessionId: "subagent_agent_child-7",
        modelRequestSessionType: ModelRequestSessionType.Subagent,
      }),
    ),
    { "session-id": "child-7" },
  );
});

test("missing session id yields no affinity headers", () => {
  assert.deepEqual(
    createSiwcCacheAffinityHeaders(
      affinityInput({ modelRequestSessionType: ModelRequestSessionType.Main }),
    ),
    {},
  );
});

test("affinity values are clamped to 64 characters, prefix included", () => {
  const longId = `sess_${"a".repeat(70)}`;
  const mainHeaders = createSiwcCacheAffinityHeaders(
    affinityInput({ sessionId: longId, modelRequestSessionType: ModelRequestSessionType.Main }),
  );
  assert.equal(mainHeaders["session-id"], "a".repeat(64));

  const subagentHeaders = createSiwcCacheAffinityHeaders(
    affinityInput({
      sessionId: "subagent_agent_child-7",
      parentSessionId: longId,
      modelRequestSessionType: ModelRequestSessionType.Subagent,
    }),
  );
  assert.equal(subagentHeaders["session-id"]!.length, 64);
  assert.ok(subagentHeaders["session-id"]!.startsWith("subagent:"));
  // thread-id 是父会话归属观测字段，不做缓存 key 截断。
  assert.equal(subagentHeaders["thread-id"], "a".repeat(70));
});

test("affinity clamp counts code points, not utf-16 units", () => {
  const astralId = `sess_${"😀".repeat(70)}`;
  const headers = createSiwcCacheAffinityHeaders(
    affinityInput({ sessionId: astralId, modelRequestSessionType: ModelRequestSessionType.Main }),
  );
  assert.equal(Array.from(headers["session-id"]!).length, 64);
});

const statusContext = {
  requestId: "req-1",
  traceId: "trace-1",
  sessionId: "subagent_agent_child-7",
  parentSessionId: "sess_parent-9",
  modelRequestSessionType: ModelRequestSessionType.Subagent,
} as unknown as ModelStatusContext;

const resolvedBase = {
  model: {} as ResolvedAiSdkModel["model"],
  properties: {} as ResolvedAiSdkModel["properties"],
  providerId: "chatgpt",
  modelId: "gpt-6.1-sol",
  providerKind: "openai",
} as ResolvedAiSdkModel;

for (const [name, build] of [
  ["generate", createGenerateTextOptions],
  ["stream", createStreamTextOptions],
] as const) {
  test(`siwcAccount binding merges affinity headers into ${name} options and overrides static headers`, () => {
    const options = build({
      includeModelIO: false,
      request: { messages: [] } as never,
      resolved: {
        ...resolvedBase,
        siwcAccount: true,
        headers: { "session-id": "static-user-value" },
      },
      statusContext,
    });
    assert.equal(options.headers?.["session-id"], "subagent:parent-9");
    assert.equal(options.headers?.["thread-id"], "parent-9");
  });

  test(`non-SIWC binding keeps the original header surface in ${name} options`, () => {
    const options = build({
      includeModelIO: false,
      request: { messages: [] } as never,
      resolved: resolvedBase,
      statusContext,
    });
    assert.equal(Object.hasOwn(options.headers ?? {}, "session-id"), false);
    assert.equal(Object.hasOwn(options.headers ?? {}, "thread-id"), false);
  });
}
