import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempRoot = join(repoRoot, ".tmp");
let fixtureRoot;
let server;
let browser;
let origin;

before(async () => {
  await mkdir(tempRoot, { recursive: true });
  fixtureRoot = await mkdtemp(join(tempRoot, "chatgpt-panel-"));
  await writeFile(
    join(fixtureRoot, "index.html"),
    '<div id="root"></div><script type="module" src="/main.tsx"></script>',
  );
  await writeFile(
    join(fixtureRoot, "main.tsx"),
    `import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ChatGptSignInPanel } from "@/settings/model-provider-section/ChatGptAccountSection.js";
const params = new URLSearchParams(location.search);
function Fixture() {
  const [phase, setPhase] = useState({
    status: "failed", reason: params.get("reason"),
    message: "HTTP 403: private-response-body",
  });
  const [action, setAction] = useState("");
  return <ZCodeIntlProvider initialLocale={params.get("locale")}>
    <ChatGptSignInPanel phase={phase}
      onRetry={() => { setAction("retry"); setPhase({ status: "signing-in" }); }}
      onCancel={() => setAction("cancel")}
      onBack={() => setAction("back")} />
    <output aria-label="Last action">{action}</output>
  </ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);`,
  );
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    logLevel: "error",
    resolve: {
      alias: { "@": join(repoRoot, "packages/ui/src") },
      dedupe: ["react", "react-dom"],
    },
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [repoRoot] } },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    channel: process.env.ZCODE_TEST_BROWSER_CHANNEL ?? "chrome",
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
  if (fixtureRoot?.startsWith(`${tempRoot}\\`) || fixtureRoot?.startsWith(`${tempRoot}/`)) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

const cases = [
  {
    locale: "zh-CN",
    serverError: "ChatGPT 服务端拒绝了登录请求，请检查网络代理出口后重试。",
    networkError: "网络异常，无法完成 ChatGPT 登录，请检查网络后重试。",
    protocolError: "ChatGPT 登录响应校验失败，请重试或稍后再试。",
    waiting: "已在浏览器打开 ChatGPT 授权页，完成授权后此处将自动继续…",
    retry: "重试",
    cancel: "取消",
    back: "返回供应商详情",
  },
  {
    locale: "en-US",
    serverError: "ChatGPT rejected the sign-in request. Check your network proxy and retry.",
    networkError: "Network error while signing in to ChatGPT. Check your connection and retry.",
    protocolError: "ChatGPT sign-in response failed verification. Please retry later.",
    waiting:
      "ChatGPT authorization page opened in your browser. This will continue automatically once you approve…",
    retry: "Retry",
    cancel: "Cancel",
    back: "Back to provider details",
  },
];

for (const scenario of cases) {
  test(`${scenario.locale}: failure reasons, retry, cancel and back`, async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${origin}?locale=${scenario.locale}&reason=server-error`);
      await page.getByText(scenario.serverError, { exact: true }).waitFor();
      assert.equal(await page.getByText("private-response-body").count(), 0);
      await page.getByRole("button", { name: scenario.retry, exact: true }).click();
      await page.getByText(scenario.waiting, { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Last action").textContent(), "retry");
      await page.getByRole("button", { name: scenario.cancel, exact: true }).click();
      assert.equal(await page.getByLabel("Last action").textContent(), "cancel");
      await page.reload();
      await page.getByText(scenario.serverError, { exact: true }).waitFor();
      await page.getByRole("button", { name: scenario.back, exact: true }).click();
      assert.equal(await page.getByLabel("Last action").textContent(), "back");
      await page.goto(`${origin}?locale=${scenario.locale}&reason=network`);
      await page.getByText(scenario.networkError, { exact: true }).waitFor();
      await page.goto(`${origin}?locale=${scenario.locale}&reason=protocol`);
      await page.getByText(scenario.protocolError, { exact: true }).waitFor();
      assert.equal(await page.getByText("private-response-body").count(), 0);
    } finally {
      await page.close();
    }
  });
}
