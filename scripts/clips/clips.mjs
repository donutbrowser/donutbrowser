// What each clip shows. `setup` runs at full speed before the take and sets
// the frame; `run` is the recorded timeline, in virtual milliseconds.
// `length` is the loop the take is cut to and `fade` the crossfade from its
// end back into its start. A clip that fades ends with the cursor where it
// started, so only the content changes across the seam. The frame never
// moves during a take: a pan changes every pixel of every frame, which an
// animated WebP pays for in full.

const SMALL = { width: 680, height: 420 };

const row = (page, name) => page.locator("tbody tr", { hasText: name }).first();
const nameCell = (page, name) =>
  row(page, name).getByText(name, { exact: true });
const launchButton = (page, name) =>
  row(page, name).locator("[data-launch-control]");
const popover = (page) =>
  page.locator("[data-radix-popper-content-wrapper]").last();
const dialog = (page) => page.locator("[role=dialog]").last();

/** The cell of a profile row under a column header. */
async function cell(page, name, header) {
  const index = await page
    .locator("thead th")
    .evaluateAll(
      (headers, text) =>
        headers.findIndex((header) => header.textContent.trim() === text),
      header,
    );
  if (index < 0) throw new Error(`No column ${header}`);
  return row(page, name).locator("td").nth(index);
}

/** Table columns to show; the rest are hidden so the clip stays readable. */
function columns(shown, { sortByName = false } = {}) {
  return {
    density: "compact",
    sorting: sortByName ? [{ id: "name", desc: false }] : [],
    visibility: Object.fromEntries(
      [
        "launched",
        "profileId",
        "state",
        "tags",
        "note",
        "proxy",
        "ext",
        "dns",
        "bot",
        "sync",
      ].map((id) => [id, shown.includes(id)]),
    ),
  };
}

/** Opens something at full speed, measures it, and closes it again. */
async function measure(page, open, target, close = "Escape") {
  await open();
  await page.waitForTimeout(900);
  const box = await target().boundingBox();
  if (close) {
    await page.keyboard.press(close);
    await page.waitForTimeout(600);
  }
  return box;
}

/** The top of the window at the clip's aspect. */
const topOfWindow = (take) => ({
  x: 0,
  y: 0,
  width: take.viewport.width,
  height: take.viewport.width / take.aspect,
});

/** The smallest box that holds every box given. */
function union(...boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/**
 * A profile cell's menu: the cursor opens it and picks an option, then
 * rests where it began. The frame holds the row above the cell and the
 * whole menu, measured before the take.
 */
function pickInCell({
  profile,
  header,
  option,
  above,
  search,
  viewport = { width: 720, height: 560 },
}) {
  return {
    viewport,
    async setup(take) {
      const { page } = take;
      const target = await cell(page, profile, header);
      const menu = await measure(
        page,
        async () => {
          await target.click();
          await page.getByRole("option", { name: option }).waitFor();
        },
        () => popover(page),
      );
      const box = await target.boundingBox();
      take.state.rest = { x: box.x + box.width * 0.7, y: box.y - 36 };
      await take.camera(
        union(await nameCell(page, above).boundingBox(), menu, box),
        { dur: 0, pad: 14 },
      );
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(await cell(page, profile, header), {
        dur: 650,
        at: [0.35, 0.5],
      });
      await take.wait(700);
      if (search) {
        await take.type(search, { cps: 9 });
        await take.wait(400);
      }
      await take.click(page.getByRole("option", { name: option }), {
        dur: 550,
      });
      await take.wait(700);
      await take.move(take.state.rest, { dur: 800, hover: false });
    },
  };
}

/** Frames a box, rests the cursor beside a control, clicks it and returns. */
function clickOnce({ open, frame, control, settle = 1300, pad = 20 }) {
  return {
    async setup(take) {
      const { page } = take;
      if (open) await open(page);
      await page.waitForTimeout(900);
      const target = await control(page).boundingBox();
      await take.camera(union(await frame(page).boundingBox(), target), {
        dur: 0,
        pad,
      });
      take.state.rest = { x: target.x - 50, y: target.y + target.height + 50 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(control(page), { dur: 650 });
      await take.wait(settle);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  };
}

export const CLIPS = {
  commandPalette: {
    length: 5400,
    poster: 0.45,
    viewport: SMALL,
    demo: { tablePrefs: columns(["state", "tags"]) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      await take.wait(500);
      await take.keys("Meta+k", ["⌘", "K"]);
      await take.wait(500);
      await take.type("netw", { cps: 9 });
      await take.wait(600);
      await take.keys("Enter", ["↵"]);
      await take.wait(1200);
      await take.keys("Escape", ["esc"]);
    },
  },
  searchSyntax: {
    length: 5600,
    fade: 250,
    poster: 0.6,
    viewport: SMALL,
    demo: { tablePrefs: columns(["proxy"]) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.state.rest = { x: 420, y: 200 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(page.getByPlaceholder(/Search profiles/), {
        dur: 600,
        at: [0.4, 0.5],
      });
      await take.wait(300);
      await take.type("proxy:none", { cps: 11 });
      await take.wait(1600);
      await take.press("Escape", { after: 300 });
      await take.keys("Meta+a", [], { show: 0, after: 40 });
      await take.press("Backspace", { after: 60 });
      await take.press("Escape", { after: 60 });
      await page.evaluate(() => document.activeElement?.blur());
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  shortcuts: {
    length: 4200,
    poster: 0.5,
    viewport: SMALL,
    demo: { tablePrefs: columns(["state", "tags"]) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      await take.wait(500);
      await take.keys("Meta+/", ["⌘", "/"]);
      await take.wait(2200);
      await take.keys("Escape", ["esc"]);
    },
  },
  groups: {
    length: 4200,
    poster: 0.3,
    viewport: SMALL,
    demo: { tablePrefs: columns(["state", "tags"]) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      await take.wait(500);
      await take.keys("Meta+2", ["⌘", "2"]);
      await take.wait(700);
      await take.keys("Meta+3", ["⌘", "3"]);
      await take.wait(700);
      await take.keys("Meta+5", ["⌘", "5"]);
      await take.wait(700);
      await take.keys("Meta+1", ["⌘", "1"]);
    },
  },
  statuses: {
    length: 4700,
    fade: 450,
    poster: 0.6,
    demo: { tablePrefs: columns(["state", "tags"]) },
    ...pickInCell({
      profile: "Ads 02",
      header: "Status",
      option: /Active/,
      above: "Ads 01",
    }),
  },
  templates: {
    length: 6000,
    fade: 250,
    fps: 15,
    poster: 0.85,
    viewport: SMALL,
    demo: { tablePrefs: columns(["state", "tags"], { sortByName: true }) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.keys("Meta+n", ["⌘", "N"]);
      await take.wait(400);
      const pick = page.getByRole("button", { name: /Template/ });
      const p = await take.point(pick);
      await take.place({ x: p.x - 40, y: p.y + 60 });
      await take.click(pick, { dur: 500 });
      await take.wait(400);
      await take.click(page.locator("[data-slot=template-option]").first(), {
        dur: 500,
      });
      await take.wait(300);
      await take.click(
        dialog(page).locator("[data-slot=profile-count-stepper] input"),
        {
          dur: 600,
        },
      );
      await take.keys("Meta+a", [], { show: 0, after: 60 });
      await take.type("5", { cps: 8 });
      await take.wait(300);
      await take.click(dialog(page).getByRole("button", { name: /^Create/ }), {
        dur: 500,
      });
      await take.wait(300);
      take.hideCursor();
      await take.wait(1400);
    },
  },
  extensionGroups: {
    length: 4700,
    fade: 450,
    poster: 0.6,
    demo: { tablePrefs: columns(["state", "ext"]) },
    ...pickInCell({
      profile: "Ads 02",
      header: "Extensions",
      option: "Work kit",
      above: "Ads 01",
    }),
  },
  importProfiles: {
    length: 6200,
    fps: 15,
    fade: 300,
    poster: 0.85,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+o");
      await page.waitForTimeout(900);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.state.rest = { x: 520, y: 300 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(page.getByText("Work", { exact: true }), { dur: 650 });
      await take.wait(350);
      await take.click(page.getByRole("button", { name: "Next" }), {
        dur: 600,
      });
      await take.wait(600);
      await take.click(page.getByRole("button", { name: /^Import/ }), {
        dur: 600,
      });
      await take.wait(1800);
    },
  },
  proxyCheck: {
    length: 5400,
    fade: 300,
    poster: 0.8,
    viewport: { width: 760, height: 520 },
    demo: { unchecked: ["px-tor"] },
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+Shift+n");
      await page.waitForTimeout(900);
      const status = (name) =>
        row(page, name).locator("td").nth(4).locator("button").first();
      const tokyo = await status("Tokyo").boundingBox();
      const card = await measure(
        page,
        () => status("Tokyo").click(),
        () => popover(page),
      );
      const s = await status("Toronto").boundingBox();
      const opened = {
        x: card.x,
        y: card.y + (s.y - tokyo.y),
        width: card.width,
        height: card.height,
      };
      const top = Math.max(0, Math.min(opened.y, s.y) - 12);
      await take.camera(
        {
          x: 0,
          y: top,
          width: take.viewport.width,
          height: take.viewport.width / 2,
        },
        { dur: 0, pad: 0 },
      );
      take.state.rest = { x: s.x + 70, y: s.y - 40 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(
        row(page, "Toronto").locator("td").nth(4).locator("button").first(),
        { dur: 650 },
      );
      await take.wait(2500);
      await take.press("Escape", { after: 300 });
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  vpn: {
    length: 4700,
    fade: 450,
    poster: 0.6,
    demo: { tablePrefs: columns(["proxy"]) },
    ...pickInCell({
      profile: "Shop · UK",
      header: "Proxy / VPN",
      option: /Zurich/,
      above: "Shop · US",
      search: "zur",
      viewport: { width: 680, height: 560 },
    }),
  },
  dnsBlocklist: {
    length: 4700,
    fade: 450,
    poster: 0.6,
    demo: { tablePrefs: columns(["state", "dns"]) },
    ...pickInCell({
      profile: "Ads 02",
      header: "DNS",
      option: "Pro++",
      above: "Ads 01",
    }),
  },
  fingerprintGate: {
    length: 7000,
    fps: 18,
    fade: 400,
    poster: 0.35,
    viewport: { width: 680, height: 600 },
    demo: {
      tablePrefs: columns(["proxy"]),
      mismatch: ["Market research"],
    },
    async setup(take) {
      const { page } = take;
      const match = page.getByRole("button", {
        name: "Match fingerprint to proxy",
      });
      await launchButton(page, "Market research").click();
      await match.waitFor();
      await page.waitForTimeout(600);
      const text = await page
        .getByText(/Exit node is in/)
        .first()
        .boundingBox();
      const buttons = union(
        await match.boundingBox(),
        await page.getByRole("button", { name: "Launch anyway" }).boundingBox(),
      );
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.waitForTimeout(800);
      await take.camera(union(text, buttons), { dur: 0, pad: 16 });
      const p = await take.point(launchButton(page, "Market research"));
      take.state.rest = { x: p.x + 150, y: p.y + 40 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(launchButton(page, "Market research"), { dur: 650 });
      await take.wait(1400);
      await take.click(
        page.getByRole("button", { name: "Match fingerprint to proxy" }),
        {
          dur: 700,
        },
      );
      await take.wait(1100);
      await take.click(launchButton(page, "Market research"), { dur: 700 });
      await take.wait(1300);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  requireRoute: {
    length: 4400,
    fade: 400,
    poster: 0.7,
    viewport: { width: 680, height: 340 },
    demo: {
      tablePrefs: columns(["proxy"]),
      settings: { require_route_for_launch: true },
    },
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+5");
      await page.waitForTimeout(700);
      // The table takes its first launch click after a group switch for
      // itself; spend it, and wait out the toast if it did launch.
      await launchButton(page, "Throwaway").click();
      await page.waitForTimeout(800);
      await page
        .locator("[data-sonner-toast]")
        .waitFor({ state: "detached", timeout: 15_000 });
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const p = await take.point(launchButton(page, "Throwaway"));
      take.state.rest = { x: p.x + 200, y: p.y + 60 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(launchButton(page, "Throwaway"), { dur: 650 });
      await take.wait(2400);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  profilePassword: {
    length: 6000,
    fade: 500,
    poster: 0.85,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await row(page, "Ads 02")
        .locator("[data-tip-anchor=row-inspect]")
        .click();
      await page.waitForTimeout(800);
      await page.getByText("Security", { exact: true }).first().click();
      await page.waitForTimeout(700);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const input = await page
        .getByPlaceholder("New password")
        .first()
        .boundingBox();
      take.state.rest = { x: input.x + input.width * 0.6, y: input.y + 120 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(page.getByPlaceholder("New password").first(), {
        dur: 600,
      });
      await take.type("correct-horse", { cps: 16 });
      await take.click(page.getByPlaceholder(/Confirm/).first(), { dur: 400 });
      await take.type("correct-horse", { cps: 16 });
      await take.click(
        dialog(page).getByRole("button", { name: "Set", exact: true }),
        {
          dur: 500,
        },
      );
      await take.wait(1500);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  clearOnClose: {
    length: 3800,
    fade: 500,
    poster: 0.6,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await row(page, "Ads 02")
        .locator("[data-tip-anchor=row-inspect]")
        .click();
      await page.waitForTimeout(900);
      const label = page.getByText("Clear data on close").first();
      await label.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const box = await label.boundingBox();
      const toggle = await page.getByRole("switch").last().boundingBox();
      await take.camera(
        union(box, toggle, {
          x: box.x - 30,
          y: box.y - 110,
          width: 10,
          height: 10,
        }),
        { dur: 0, pad: 16 },
      );
      take.state.rest = { x: toggle.x - 90, y: toggle.y - 50 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(page.getByRole("switch").last(), { dur: 650 });
      await take.wait(1200);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  totp: {
    length: 5400,
    poster: 0.8,
    viewport: SMALL,
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      await take.wait(400);
      await take.keys("Meta+Shift+o", ["⌘", "⇧", "O"]);
      await take.wait(500);
      await take.type("JBSWY3DPEHPK3PXP", { cps: 16 });
      await take.wait(2000);
      await take.keys("Escape", ["esc"]);
    },
  },
  trash: {
    length: 4200,
    fade: 500,
    poster: 0.25,
    viewport: SMALL,
    demo: { trash: true },
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+Shift+t");
      await page.waitForTimeout(900);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const restore = page
        .locator("tbody tr")
        .first()
        .getByRole("button")
        .first();
      const p = await take.point(restore);
      take.state.rest = { x: p.x - 120, y: p.y + 90 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(
        page.locator("tbody tr").first().getByRole("button").first(),
        {
          dur: 700,
        },
      );
      await take.wait(1500);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  selfHostedSync: {
    length: 7000,
    fps: 18,
    fade: 500,
    poster: 0.9,
    viewport: { width: 760, height: 420 },
    demo: { paid: false },
    async setup(take) {
      const { page } = take;
      await page.route("https://sync.example.org/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"status":"ok"}',
        }),
      );
      await page.keyboard.press("Meta+Shift+a");
      await page.waitForTimeout(800);
      await page.getByText("Self-hosted", { exact: true }).first().click();
      await page.waitForTimeout(800);
      const form = await page
        .getByText("Self-hosted sync server")
        .first()
        .boundingBox();
      const test = await page
        .getByRole("button", { name: "Test connection" })
        .boundingBox();
      await take.camera(union(form, test, { ...form, x: form.x - 30 }), {
        dur: 0,
        pad: 26,
      });
      take.state.rest = { x: test.x - 40, y: test.y + 50 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.click(page.getByPlaceholder("https://sync.example.com"), {
        dur: 600,
      });
      await take.type("https://sync.example.org", { cps: 22 });
      await take.click(page.getByPlaceholder(/sync token/i), { dur: 500 });
      await take.type("dsk_7f3a9c2e41b8d605", { cps: 22 });
      await take.click(page.getByRole("button", { name: "Test connection" }), {
        dur: 500,
      });
      await take.wait(1600);
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  defaultBrowser: {
    length: 3800,
    fade: 500,
    poster: 0.75,
    viewport: SMALL,
    ...clickOnce({
      open: async (page) => {
        await page.keyboard.press("Meta+,");
        await page.waitForTimeout(800);
        await page
          .getByText("Default Browser", { exact: true })
          .first()
          .click();
      },
      frame: (page) => page.getByText(/is not your default browser/).first(),
      control: (page) => page.getByRole("button", { name: /Set as default/ }),
    }),
  },
  localApi: {
    length: 4400,
    fade: 500,
    poster: 0.75,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+i");
      await page.waitForTimeout(900);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const t = await page.getByRole("switch").first().boundingBox();
      take.state.rest = { x: t.x - 70, y: t.y + 70 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(page.getByRole("switch").first(), { dur: 650 });
      await take.wait(1700);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  feedback: {
    length: 6000,
    fade: 250,
    poster: 0.75,
    viewport: SMALL,
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      take.hideCursor({ dur: 0 });
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.keys("Meta+Shift+f", ["⌘", "⇧", "F"]);
      await take.wait(500);
      const idea = dialog(page).getByText("Idea", { exact: true });
      const p = await take.point(idea);
      await take.place({ x: p.x + 50, y: p.y + 70 });
      await take.click(idea, { dur: 500 });
      await take.wait(300);
      await take.click(dialog(page).locator("textarea").first(), { dur: 500 });
      await take.type("Let me pin a group to the top.", { cps: 18 });
      await take.wait(1000);
      take.hideCursor();
      await take.keys("Escape", ["esc"]);
    },
  },
  newProfile: {
    length: 5000,
    fade: 500,
    poster: 0.85,
    viewport: SMALL,
    output: { width: 864, height: 288 },
    demo: { tablePrefs: columns(["state", "tags"], { sortByName: true }) },
    async setup(take) {
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const p = await take.point(
        take.page.getByRole("button", { name: "New", exact: true }),
      );
      take.state.rest = { x: p.x - 110, y: p.y + 120 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.click(page.getByRole("button", { name: "New", exact: true }), {
        dur: 650,
      });
      await take.wait(500);
      await take.type("Ads 03", { cps: 10 });
      await take.wait(200);
      await take.click(dialog(page).getByRole("button", { name: /^Create/ }), {
        dur: 600,
      });
      await take.wait(1300);
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  welcome: {
    length: 5200,
    fade: 600,
    poster: 0.8,
    viewport: SMALL,
    output: { width: 864, height: 288 },
    demo: { tablePrefs: columns(["state", "proxy"]) },
    async setup(take) {
      const { page } = take;
      await take.camera(
        union(
          await nameCell(page, "Shop · US").boundingBox(),
          await launchButton(page, "Shop · US").boundingBox(),
          await (
            await cell(page, "Social · Main", "Proxy / VPN")
          ).boundingBox(),
        ),
        { dur: 0, pad: 16 },
      );
      take.state.rest = await take.point(nameCell(page, "Shop · UK"), {
        at: [1.6, 0.5],
      });
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.click(launchButton(page, "Shop · US"), { dur: 600 });
      await take.wait(500);
      await take.click(launchButton(page, "Ads 01"), { dur: 450 });
      await take.wait(500);
      await take.click(launchButton(page, "Social · Main"), { dur: 450 });
      await take.wait(1300);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  crossOs: {
    length: 5200,
    fps: 18,
    fade: 250,
    poster: 0.55,
    viewport: { width: 680, height: 560 },
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+n");
      await page.waitForTimeout(900);
      const os = () =>
        page.getByRole("combobox").filter({ hasText: /macOS/ }).first();
      const menu = await measure(
        page,
        () => os().click(),
        () => popover(page),
      );
      await take.camera(union(await dialog(page).boundingBox(), menu), {
        dur: 0,
        pad: 12,
      });
      const box = await os().boundingBox();
      take.state.rest = { x: box.x - 60, y: box.y + 70 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      const os = () =>
        page
          .getByRole("combobox")
          .filter({ hasText: /macOS|Windows|Linux/ })
          .first();
      await take.wait(400);
      await take.click(os(), { dur: 600 });
      await take.wait(500);
      await take.click(page.getByRole("option", { name: /Windows/ }), {
        dur: 500,
      });
      await take.wait(900);
      await take.click(os(), { dur: 500 });
      await take.wait(500);
      await take.click(page.getByRole("option", { name: /macOS/ }), {
        dur: 500,
      });
      await take.wait(500);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  team: {
    length: 5400,
    fade: 500,
    poster: 0.3,
    viewport: SMALL,
    demo: {
      tablePrefs: columns(["state", "tags"]),
      locks: [{ profile: 3, email: "sam@example.com" }],
    },
    async setup(take) {
      const { page } = take;
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const p = await take.point(launchButton(page, "Ads 01"));
      take.state.rest = { x: p.x + 220, y: p.y + 80 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.move(launchButton(page, "Ads 01"), { dur: 650 });
      await take.wait(1500);
      await page.evaluate(() => {
        window.__CLIP_DATA__.locks = [];
        window.__clipEmit("profile-lock-changed", {
          profileId: null,
          action: "released",
        });
      });
      await take.wait(800);
      await take.click(null);
      await take.wait(1300);
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  cloudBackup: {
    length: 4600,
    fade: 500,
    poster: 0.8,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await row(page, "Ads 02")
        .locator("[data-tip-anchor=row-inspect]")
        .click();
      await page.waitForTimeout(800);
      await page.getByText("Sync", { exact: true }).first().click();
      await page.waitForTimeout(700);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const select = await page
        .getByRole("combobox", { name: /Sync mode/i })
        .boundingBox();
      take.state.rest = { x: select.x + select.width * 0.5, y: select.y + 110 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(page.getByRole("combobox", { name: /Sync mode/i }), {
        dur: 600,
        at: [0.3, 0.5],
      });
      await take.wait(500);
      await take.click(page.getByRole("option", { name: "Regular Sync" }), {
        dur: 500,
      });
      await take.wait(1900);
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  cookieBot: {
    length: 5600,
    fade: 300,
    poster: 0.85,
    viewport: { width: 900, height: 640 },
    demo: { synced: ["Ads 01", "Shop · UK", "Social · Main"] },
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+b");
      await page.waitForTimeout(900);
      const enrol = page.getByRole("button", { name: "Enrol a profile" });
      const box = await measure(
        page,
        () => enrol.click(),
        () => dialog(page),
      );
      await take.camera(
        { ...box, height: Math.min(box.height, 300) },
        {
          dur: 0,
          pad: 8,
        },
      );
      const p = await enrol.boundingBox();
      take.state.rest = { x: p.x + p.width + 60, y: p.y - 40 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(300);
      await take.click(page.getByRole("button", { name: "Enrol a profile" }), {
        dur: 600,
      });
      await take.wait(500);
      await take.click(dialog(page).getByText("Ads 01", { exact: true }), {
        dur: 500,
      });
      await take.click(dialog(page).getByText("Shop · UK", { exact: true }), {
        dur: 400,
      });
      await take.wait(200);
      await take.move(
        dialog(page).getByRole("button", { name: /Continue with/ }),
        {
          dur: 600,
        },
      );
      await take.wait(1200);
      take.hideCursor();
      await take.press("Escape", { after: 600 });
    },
  },
  synchronizer: {
    length: 5600,
    fade: 500,
    poster: 0.7,
    viewport: { width: 760, height: 520 },
    async setup(take) {
      const { page } = take;
      await row(page, "Ads 02")
        .locator("[data-tip-anchor=row-inspect]")
        .click();
      await page.waitForTimeout(700);
      await page.getByText("Launch hook", { exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.locator("[data-slot=profile-start-synchronizer]").click();
      await page.waitForTimeout(900);
      const box = await dialog(page).boundingBox();
      await take.camera(box, { dur: 0, pad: 10 });
      take.state.rest = {
        x: box.x + box.width * 0.75,
        y: box.y + box.height * 0.55,
      };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(dialog(page).getByText("Shop · US", { exact: true }), {
        dur: 650,
      });
      await take.click(dialog(page).getByText("Shop · UK", { exact: true }), {
        dur: 400,
      });
      await take.wait(300);
      await take.click(
        dialog(page).getByRole("button", { name: /Send example click/ }),
        {
          dur: 600,
        },
      );
      await take.wait(1800);
      await take.move(take.state.rest, { dur: 600, hover: false });
    },
  },
  automation: {
    length: 5200,
    fps: 18,
    fade: 500,
    poster: 0.8,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await row(page, "Ads 02")
        .locator("[data-tip-anchor=row-inspect]")
        .click();
      await page.waitForTimeout(700);
      await page.getByText("Launch hook", { exact: true }).first().click();
      await page.waitForTimeout(600);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const launch = await dialog(page)
        .getByRole("button", { name: "Launch Ads 02" })
        .boundingBox();
      take.state.rest = { x: launch.x - 120, y: launch.y + 140 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(400);
      await take.click(
        dialog(page).getByRole("button", { name: "Launch Ads 02" }),
        {
          dur: 700,
        },
      );
      await take.wait(2200);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  remoteControl: {
    length: 4400,
    fps: 18,
    fade: 500,
    poster: 0.8,
    viewport: SMALL,
    async setup(take) {
      const { page } = take;
      await page.keyboard.press("Meta+i");
      await page.waitForTimeout(800);
      await page.getByText("Remote MCP", { exact: true }).first().click();
      await page.waitForTimeout(800);
      await take.camera(topOfWindow(take), { dur: 0, pad: 0 });
      const toggle = await page.getByRole("switch").first().boundingBox();
      take.state.rest = { x: toggle.x - 80, y: toggle.y + 80 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(500);
      await take.click(page.getByRole("switch").first(), { dur: 650 });
      await take.wait(1800);
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
  agent: {
    length: 6200,
    fps: 18,
    fade: 300,
    poster: 0.3,
    viewport: { width: 900, height: 560 },
    ready: "body",
    demo: { agents: true, settings: { mcp_remote_enabled: true } },
    async setup(take) {
      const { page } = take;
      await page.waitForSelector("tbody tr");
      await page.keyboard.press("Meta+j");
      await page.getByText("Needs you").waitFor();
      await page.waitForTimeout(600);
      const card = await page.getByText("Needs you").boundingBox();
      const note = await page.getByPlaceholder(/Write a note/).boundingBox();
      await take.camera(union(card, note), { dur: 0, pad: 6 });
      take.state.rest = { x: note.x + note.width * 0.5, y: card.y + 150 };
      await take.place(take.state.rest);
    },
    async run(take) {
      const { page } = take;
      await take.wait(600);
      await take.click(
        page.getByRole("button", { name: "The billing address" }),
        {
          dur: 700,
        },
      );
      await take.wait(900);
      await take.click(page.getByPlaceholder(/Write a note/), { dur: 700 });
      await take.type("Skip order 1043 for now.", { cps: 18 });
      await take.press("Enter", { after: 1300 });
      await take.move(take.state.rest, { dur: 700, hover: false });
    },
  },
};
