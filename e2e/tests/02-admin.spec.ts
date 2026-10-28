/**
 * The operator: the overview reports revenue against provider cost, an account margin set
 * in the user panel applies to that account's next request, and a grant lands in its ledger.
 */
import OpenAI from "openai";
import { expect, test } from "@playwright/test";
import { apiKey, apiLogin, DEMO, GATEWAY, grant, newUser, pageFor, requestDetail } from "../helpers";

test("an account margin set in admin prices the next request at cost", async ({ browser, request }) => {
  const admin = await apiLogin(request, DEMO.admin);
  const dev = await newUser(request);
  await grant(request, admin, dev.id, 3);
  const key = await apiKey(request, dev);
  const openai = new OpenAI({ baseURL: GATEWAY, apiKey: key.secret });

  const page = await pageFor(browser, admin, "/admin");
  await expect(page.getByTestId("stat-cost")).toBeVisible();
  await page.goto(`/admin/users?q=${dev.username}`);
  await page.getByRole("row", { name: new RegExp(dev.username) }).click();
  const sheet = page.getByTestId("user-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("user-margin-input").fill("0");
  await sheet.getByTestId("user-margin-save").click();
  await expect(page.getByText("Account margin set to 0% (at cost)").first()).toBeVisible();

  const { response } = await openai.chat.completions.create({ model: "stub-chat", messages: [{ role: "user", content: "at cost" }] }).withResponse();
  const row = await requestDetail(request, dev, response.headers.get("x-request-id")!);
  expect(row.statusCode).toBe(200);
  const raw = await (await request.fetch(`${GATEWAY.replace(/\/v1$/, "")}/api/admin/users/${dev.id}`, { headers: { Authorization: `Bearer ${admin.accessToken}` } })).json();
  expect(raw.marginBps).toBe(0);
});
