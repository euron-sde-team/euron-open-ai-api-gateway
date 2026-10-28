/** Every console and admin page passes axe (WCAG 2.1 A and AA) in light and dark themes. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { apiLogin, DEMO, grant, newUser, pageFor } from "../helpers";

const CONSOLE = ["/", "/keys", "/usage", "/models", "/playground", "/billing", "/docs", "/settings"];
const ADMIN = ["/admin", "/admin/users", "/admin/providers", "/admin/models", "/admin/health", "/admin/topups", "/admin/tiers", "/admin/settings", "/admin/audit"];

for (const scheme of ["light", "dark"] as const) {
  test(`console and admin pages have no axe violations (${scheme})`, async ({ browser, request }) => {
    const admin = await apiLogin(request, DEMO.admin);
    const dev = await newUser(request);
    await grant(request, admin, dev.id, 1);
    for (const [user, paths] of [
      [dev, CONSOLE],
      [admin, ADMIN],
    ] as const) {
      const page = await pageFor(browser, user);
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("main h1").first()).toBeVisible();
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const summary = result.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.html.slice(0, 160)}`);
        expect(summary, `${path} in ${scheme}`).toEqual([]);
      }
      await page.context().close();
    }
  });
}
