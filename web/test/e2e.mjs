// Headless e2e against the stub server (dist build must exist).
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:7791";
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

// ---- list view ----
await page.goto(BASE + "/#/");
await page.waitForTimeout(700);
check("list renders", (await page.locator(".sess-row").count()) === 2);

// ---- open session (canvas) ----
await page.locator('.sess-row:has-text("panic")').first().click();
await page.waitForTimeout(1200);
check("canvas mounts", (await page.locator("#zoomWrap > .panel").count()) === 1);
check("timeline zone", (await page.locator(".tl-bar").count()) === 1);
check("plan card", (await page.locator(".plan-card").count()) >= 1);
check("choice card", (await page.locator(".choice-card").count()) >= 1);
check("choice selection detected", (await page.locator(".ch-opt.sel:has-text('rayon')").count()) === 1);
check("image chip", (await page.locator(".img-chip").count()) >= 1);
check("hljs highlighting", (await page.locator(".cb .hljs-keyword").count()) >= 1);

// ---- fork open + dock ----
const scroll = page.locator(".panel-scroll").first();
await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.5));
await page.waitForTimeout(300);
const forkCards = await page.locator(".rc").count();
check("fork cards exist", forkCards >= 2, `count=${forkCards}`);
await page.locator(".rc").last().click();
await page.waitForTimeout(1000);
check("branch column opens", (await page.locator("#zoomWrap > .panel.branch").count()) === 1);
check("flare pill", (await page.locator(".flare-pill").count()) === 1);
await page.locator(".flare-pill").click();
await page.waitForTimeout(600);
check("flare pill closes branch", (await page.locator("#zoomWrap > .panel.branch").count()) === 0);

// ---- code: flow split then close ----
await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.6));
await page.waitForTimeout(300);
const wrap = page.locator(".cb-wrap").first();
await wrap.hover({ force: true });
await page.waitForTimeout(400);
if (await page.locator(".cb-pop").count()) await page.locator(".cb-pop").click();
else await wrap.click({ force: true });
await page.waitForTimeout(700);
check("flow code column", (await page.locator(".panel.code:not(.codewin)").count()) === 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// ---- palette ----
await page.locator("#ckHint").click();
await page.waitForTimeout(400);
check("palette opens from searchbox", (await page.locator(".pal").count()) === 1);
await page.keyboard.type("rayon");
await page.waitForTimeout(300);
check("palette finds message", (await page.locator(".pal-item").count()) >= 1);
await page.keyboard.press("Escape");

// ---- annotation + persistence ----
await page.mouse.dblclick(400, 250);
await page.waitForTimeout(300);
await page.keyboard.type("영속성 테스트 메모");
await page.waitForTimeout(600);
check("note created", (await page.locator(".note-card").count()) === 1);

// ---- route away and back (teardown / remount) ----
await page.goto(BASE + "/#/");
await page.waitForTimeout(500);
check("teardown clears timeline", (await page.locator(".tl-bar").count()) === 0);
check("teardown clears overlays", (await page.locator(".overview").count()) === 0);
await page.locator('.sess-row:has-text("panic")').first().click();
await page.waitForTimeout(1200);
check("remount ok", (await page.locator("#zoomWrap > .panel").count()) === 1);
check("note persisted (localStorage)", (await page.locator(".note-card").count()) === 1);
check("single timeline after remount", (await page.locator(".tl-bar").count()) === 1);

check("no js errors", errs.length === 0, errs.slice(0, 3).join(" | ").slice(0, 300));
await browser.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
