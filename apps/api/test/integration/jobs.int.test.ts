/** The scheduled jobs: the reservation sweeper, health probes and the breaker, the low-balance email, retention. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../../src/core/ids";
import { db } from "../../src/db/kysely";
import { reserve, RESERVATION_TTL_MS, sweepReservations } from "../../src/billing/wallet";
import { circuitState } from "../../src/gateway/breaker";
import { clearSentMail, sentMail } from "../../src/integrations/mail/mailer";
import { applyRetention } from "../../src/jobs/maintenance.jobs";
import { notifyLowBalances, runHealthProbes } from "../../src/jobs/gateway.jobs";
import { createKey, createUser, gw, requestRow, resetGatewayState, resetSettings, setSettings, walletOf } from "./harness";

beforeEach(async () => resetGatewayState());
afterAll(async () => resetSettings());

describe("the reservation sweeper", () => {
  it("releases holds whose request never settled, and only those", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const stale = await reserve(ada.id, 300_000);
    await reserve(ada.id, 200_000);
    expect((await walletOf(ada.id)).reserved).toBe(500_000);
    await db.updateTable("reservations").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", stale).execute();
    expect(await sweepReservations()).toBeGreaterThanOrEqual(1);
    expect(await walletOf(ada.id)).toEqual({ balance: 1_000_000, reserved: 200_000 });
    expect((await db.selectFrom("reservations").select("status").where("id", "=", stale).executeTakeFirstOrThrow()).status).toBe("RELEASED");
    expect(RESERVATION_TTL_MS).toBeGreaterThan(60_000);
  });
});

describe("health probes", () => {
  it("record a check per usable route and open the circuit of a dead provider", async () => {
    const id = `t-dead-${newId().slice(-6).toLowerCase()}`;
    await db.insertInto("providers").values({ id, kind: "OPENAI_COMPATIBLE", display_name: "Dead", base_url: "http://127.0.0.1:9/v1" }).execute();
    const { encryptCredential } = await import("../../src/security/credentials");
    const credId = newId();
    await db.insertInto("provider_credentials").values({ id: credId, provider_id: id, label: "k", ciphertext: encryptCredential("sk-dead-provider-0000", credId), last4: "0000" }).execute();
    await db.insertInto("models").values({ id, kind: "CHAT", display_name: "Dead", enabled: true }).execute();
    const routeId = newId();
    await db.insertInto("model_routes").values({ id: routeId, model_id: id, provider_id: id, upstream_model: "x", input_micros_per_mtok: 1, output_micros_per_mtok: 1 }).execute();
    await resetGatewayState();
    for (let i = 0; i < 5; i++) expect(await runHealthProbes()).toBeGreaterThanOrEqual(1);
    expect(await circuitState(routeId)).toBe("open");
    const checks = await db.selectFrom("health_checks").select(["ok", "error"]).where("route_id", "=", routeId).execute();
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => !c.ok && c.error === "The provider could not be reached")).toBe(true);
    const stubRoute = await db.selectFrom("model_routes").select("id").where("model_id", "=", "stub-chat").executeTakeFirstOrThrow();
    expect((await db.selectFrom("health_checks").select("ok").where("route_id", "=", stubRoute.id).orderBy("checked_at", "desc").executeTakeFirstOrThrow()).ok).toBe(true);
    await db.deleteFrom("providers").where("id", "=", id).execute();
    await db.deleteFrom("models").where("id", "=", id).execute();
  });
});

describe("the low-balance email", () => {
  it("goes once to an account that has used the API and fell below the threshold, and again only after a credit", async () => {
    await setSettings({ lowBalanceMicros: 500_000 });
    const ada = await createUser({ balanceMicros: 400_000 });
    const idle = await createUser({ balanceMicros: 100 });
    const key = await createKey(ada);
    await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 5, messages: [{ role: "user", content: "x" }] }));
    clearSentMail();
    await notifyLowBalances();
    await notifyLowBalances();
    const mine = sentMail().filter((m) => m.to === ada.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/balance is low/);
    expect(sentMail().some((m) => m.to === idle.email)).toBe(false);
    const { credit } = await import("../../src/billing/wallet");
    await credit({ userId: ada.id, type: "GRANT", amountMicros: 1, refType: "test", refId: newId(), description: "x" });
    await notifyLowBalances();
    expect(sentMail().filter((m) => m.to === ada.email)).toHaveLength(2);
  });
});

describe("retention", () => {
  it("deletes expired bodies always, and request rows only when a retention period is set", async () => {
    const ada = await createUser({ balanceMicros: 1_000_000 });
    const key = await createKey(ada, { logBodies: true });
    const row = await requestRow(await gw(key.secret).post("/v1/chat/completions").send({ model: "stub-chat", max_tokens: 5, messages: [{ role: "user", content: "x" }] }));
    await db.updateTable("request_bodies").set({ expires_at: new Date(Date.now() - 1000) }).where("request_id", "=", row.id).execute();
    await db.updateTable("requests").set({ created_at: new Date(Date.now() - 400 * 86_400_000) }).where("id", "=", row.id).execute();
    await resetSettings();
    expect((await applyRetention()).bodies).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("requests").select("id").where("id", "=", row.id).executeTakeFirst()).toBeTruthy();
    await setSettings({ requestRetentionDays: 365 });
    expect((await applyRetention()).requests).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom("requests").select("id").where("id", "=", row.id).executeTakeFirst()).toBeUndefined();
  });
});
