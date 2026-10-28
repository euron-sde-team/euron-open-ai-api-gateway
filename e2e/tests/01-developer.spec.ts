/**
 * A developer's first hour: sign in, create a key in the console, call the gateway with the
 * official OpenAI and Anthropic SDKs (streaming included), see each request priced on the
 * Usage page, and top up through checkout.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { expect, test } from "@playwright/test";
import { apiLogin, DEMO, GATEWAY, grant, newUser, pageFor, requestDetail } from "../helpers";

test("create a key, call models with both SDKs, and see the requests priced", async ({ browser, request }) => {
  const admin = await apiLogin(request, DEMO.admin);
  const dev = await newUser(request);
  await grant(request, admin, dev.id, 5);
  const page = await pageFor(browser, dev);

  await expect(page.getByTestId("getting-started")).toBeVisible();
  await page.getByTestId("nav-api-keys").click();
  await page.getByTestId("create-key").click();
  await page.getByLabel("Name").fill("Laptop");
  await page.getByTestId("save-key").click();
  const secret = (await page.getByTestId("created-key-secret").textContent())!.trim();
  expect(secret).toMatch(/^gw-[A-Za-z0-9]{40}$/);
  await page.getByRole("button", { name: "I have stored it" }).click();
  await expect(page.getByText(secret)).toHaveCount(0);

  const openai = new OpenAI({ baseURL: GATEWAY, apiKey: secret });
  const reply = await openai.chat.completions.create({ model: "stub-chat", messages: [{ role: "user", content: "hello from the OpenAI SDK" }] });
  expect(reply.model).toBe("stub-chat");
  expect(reply.choices[0]!.message.content).toBe("Stub reply to: hello from the OpenAI SDK");
  const { response } = await openai.chat.completions.create({ model: "stub-claude", messages: [{ role: "user", content: "translated" }], stream: true, stream_options: { include_usage: true } }).withResponse();
  const requestId = response.headers.get("x-request-id")!;
  const stream = await openai.chat.completions.create({ model: "stub-claude", messages: [{ role: "user", content: "translated" }], stream: true });
  let text = "";
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? "";
  expect(text).toBe("Stub reply to: translated");

  const anthropic = new Anthropic({ baseURL: GATEWAY.replace(/\/v1$/, ""), apiKey: secret });
  const message = await anthropic.messages.create({ model: "stub-chat", max_tokens: 64, messages: [{ role: "user", content: "hello from the Anthropic SDK" }] });
  expect(message.content[0]).toMatchObject({ type: "text", text: "Stub reply to: hello from the Anthropic SDK" });

  const row = await requestDetail(request, dev, requestId);
  expect(row).toMatchObject({ modelId: "stub-claude", statusCode: 200, stream: true });
  expect(row.priceMicros as number).toBeGreaterThan(0);

  await page.getByTestId("nav-usage").click();
  await expect(page.getByRole("row", { name: /stub-claude/ }).first()).toBeVisible();
  await expect(page.getByRole("row", { name: /stub-chat.*\/v1\/messages/ }).first()).toBeVisible();
});

test("a key limited to one model is refused the others, and a revoked key stops at once", async ({ browser, request }) => {
  const admin = await apiLogin(request, DEMO.admin);
  const dev = await newUser(request);
  await grant(request, admin, dev.id, 2);
  const page = await pageFor(browser, dev, "/keys?new=1");
  const dialog = page.getByTestId("key-dialog");
  await dialog.getByLabel("Name").fill("Embeddings only");
  await dialog.getByRole("button", { name: /Limit this key/ }).click();
  await dialog.getByRole("checkbox").first().click();
  await dialog.getByText("stub-embed", { exact: true }).click();
  await dialog.getByTestId("save-key").click();
  const secret = (await page.getByTestId("created-key-secret").textContent())!.trim();
  await page.getByRole("button", { name: "I have stored it" }).click();

  const openai = new OpenAI({ baseURL: GATEWAY, apiKey: secret, maxRetries: 0 });
  const emb = await openai.embeddings.create({ model: "stub-embed", input: "vectors" });
  expect(emb.data[0]!.embedding.length).toBeGreaterThan(0);
  await expect(openai.chat.completions.create({ model: "stub-chat", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ status: 403, code: "model_not_allowed" });

  await page.getByRole("button", { name: "Revoke Embeddings only" }).click();
  await page.getByTestId("revoke-dialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByTestId("keys-page").getByText("Revoked", { exact: true })).toBeVisible();
  await expect(openai.embeddings.create({ model: "stub-embed", input: "x" })).rejects.toMatchObject({ status: 401 });
});

test("top up through checkout and see the balance and the ledger move", async ({ browser, request }) => {
  const dev = await newUser(request);
  const page = await pageFor(browser, dev, "/billing");
  await expect(page.getByTestId("wallet-available")).toBeVisible();
  const before = await page.getByTestId("wallet-available").textContent();
  await page.getByLabel("Amount (USD)").fill("10");
  await expect(page.getByTestId("topup-preview")).toContainText("$10.00");
  await page.getByTestId("topup-submit").click();

  // Stripe (here the stubs' hosted-checkout stand-in) redirects; the test gateway confirms in a dialog.
  const stubDialog = page.getByTestId("stub-payment-dialog");
  const stripePay = page.getByTestId("stub-pay");
  await expect(stubDialog.or(stripePay)).toBeVisible();
  if (await stripePay.isVisible()) {
    await stripePay.click();
    await expect(page).toHaveURL(/\/billing/);
  } else {
    await stubDialog.getByRole("button", { name: "Confirm test payment" }).click();
  }
  await expect(page.getByTestId("wallet-available")).not.toHaveText(before ?? "", { timeout: 20_000 });
  await expect(page.getByRole("row", { name: /Top-up.*\+\$10\.00/ })).toBeVisible();
});
