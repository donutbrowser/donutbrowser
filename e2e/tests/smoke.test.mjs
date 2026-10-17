import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appFromEnvironment, withApp } from "../lib/app.mjs";

test("table views persist separately, migrate the old sort, and reject invalid settings", async () => {
  await withApp("smoke-table-views", async (app) => {
    await app.invoke("save_table_sorting_settings", {
      sorting: { column: "created_at", direction: "desc" },
    });
    assert.deepEqual(
      (await app.invoke("get_table_preferences", { tableId: "profiles" }))
        .sorting,
      [{ id: "created_at", desc: true }],
    );
    const preferences = {
      visibility: { note: false, tags: true },
      sizing: { name: 280 },
      sorting: [
        { id: "name", desc: true },
        { id: "sync", desc: false },
      ],
      density: "comfortable",
    };
    await app.invoke("save_table_preferences", {
      tableId: "proxies",
      preferences,
    });
    assert.deepEqual(
      await app.invoke("get_table_preferences", { tableId: "proxies" }),
      preferences,
    );
    assert.equal(
      (await app.invoke("get_table_preferences", { tableId: "groups" }))
        .density,
      "compact",
    );
    for (const args of [
      { tableId: "../outside", preferences },
      {
        tableId: "proxies",
        preferences: { ...preferences, sizing: { name: -1 } },
      },
      {
        tableId: "proxies",
        preferences: {
          ...preferences,
          sorting: [
            { id: "name", desc: true },
            { id: "name", desc: false },
          ],
        },
      },
    ])
      assert.match(
        await app.invokeError("save_table_preferences", args),
        /TABLE_PREFERENCES_INVALID/,
      );
    assert.match(
      await app.invokeError("get_table_preferences", { tableId: "../outside" }),
      /TABLE_PREFERENCES_INVALID/,
    );
    await app.restart();
    assert.deepEqual(
      await app.invoke("get_table_preferences", { tableId: "proxies" }),
      preferences,
    );
    const saved = JSON.parse(
      await readFile(
        path.join(app.dataRoot, "data", "settings", "table_proxies.json"),
        "utf8",
      ),
    );
    assert.deepEqual(saved, preferences);
  });
});

test("fresh app renders, completes onboarding, persists settings, and never touches real app roots", async () => {
  await withApp(
    "smoke-fresh",
    async (app) => {
      assert.equal(typeof (await app.session.title()), "string");
      assert.match(await app.bodyText(), /New/);
      await app.waitForText("No profiles yet");

      const initial = await app.invoke("get_app_settings");
      assert.equal(typeof initial.onboarding_completed, "boolean");
      await app.invoke("complete_onboarding");
      assert.equal(await app.invoke("get_onboarding_completed"), true);
      await app.invoke("dismiss_window_resize_warning");
      assert.equal(
        await app.invoke("get_window_resize_warning_dismissed"),
        true,
      );

      // Where the app draws its own titlebar it also owns the window controls,
      // so it needs the desktop's button layout to know which side they go on.
      const decorations = await app.invoke("get_window_decoration_layout");
      assert.equal(typeof decorations?.client_side, "boolean");
      if (decorations.client_side) {
        // Only reported where decorations were actually dropped, which is
        // every Linux session except KDE on Wayland.
        assert.equal(process.platform, "linux");
        // `layout` may be null when GtkSettings is unavailable; the frontend
        // falls back to the default arrangement rather than drawing nothing,
        // so asserting a string here would be stricter than the contract.
        if (decorations.layout !== null) {
          assert.equal(typeof decorations.layout, "string");
          assert.match(
            decorations.layout,
            /close|minimize|maximize/,
            `layout must name a drawable control, got: ${decorations.layout}`,
          );
        }
      } else {
        // The platform still draws a titlebar; the app must not draw a second.
        assert.equal(decorations.layout, null);
      }

      const saved = await app.invoke("save_app_settings", {
        settings: {
          ...initial,
          theme: "dark",
          language: "en",
          onboarding_completed: true,
          disable_auto_updates: true,
        },
      });
      assert.equal(saved.theme, "dark");
      assert.equal(saved.language, "en");

      await app.invoke("save_table_sorting_settings", {
        sorting: { column: "browser", direction: "desc" },
      });
      assert.deepEqual(await app.invoke("get_table_sorting_settings"), {
        column: "browser",
        direction: "desc",
      });
      assert.ok((await app.invoke("get_system_language")).length >= 2);
      const system = await app.invoke("get_system_info");
      assert.ok(system && typeof system === "object");
      assert.equal(typeof (await app.invoke("read_log_files")), "string");

      // Feature tips: what was read, the tip on the Profiles page, the day
      // the next one may come, and the decision behind the paid-plan welcome
      // all live in the settings file.
      const tips = await app.invoke("get_tips_state");
      assert.equal(tips.auto_show, true);
      assert.deepEqual(tips.seen, []);
      assert.deepEqual(tips.used, []);
      assert.equal(tips.inline_tip, null);
      assert.equal(tips.next_auto_show_at, null);
      assert.equal(tips.auto_due, true, "a fresh install owes its first tip");
      const shown = await app.invoke("show_inline_tip", {
        tipId: "dnsBlocklist",
      });
      assert.equal(shown.inline_tip, "dnsBlocklist");
      assert.equal(typeof shown.last_auto_shown_at, "number");
      assert.equal(shown.auto_due, false, "one tip at a time");
      assert.equal(
        (await app.invoke("show_inline_tip", { tipId: "trash" })).inline_tip,
        "dnsBlocklist",
        "the tip on the page stays until it is closed",
      );
      const browsed = await app.invoke("mark_tip_seen", {
        tipId: "proxyCheck",
      });
      assert.deepEqual(browsed.seen, ["proxyCheck"]);
      assert.equal(
        browsed.inline_tip,
        "dnsBlocklist",
        "reading another tip leaves the one on the page",
      );
      assert.equal(browsed.next_auto_show_at, null);
      const released = await app.invoke("release_inline_tip", {
        tipId: "dnsBlocklist",
      });
      assert.equal(released.inline_tip, null);
      assert.ok(
        !released.seen.includes("dnsBlocklist"),
        "a tip the seat lost goes back to the pool unread",
      );
      assert.equal(released.auto_due, false, "the day's tip was shown already");
      const marked = await app.invoke("mark_tip_seen", {
        tipId: "dnsBlocklist",
      });
      assert.deepEqual(marked.seen, ["proxyCheck", "dnsBlocklist"]);
      assert.equal(marked.inline_tip, null);
      const wait = marked.next_auto_show_at - Math.floor(Date.now() / 1000);
      assert.ok(
        wait >= 12 * 60 * 60 - 60 && wait <= 24 * 60 * 60,
        `the next tip waits for the next day, not ${wait} seconds`,
      );
      assert.equal(marked.auto_due, false, "not again the same day");
      const used = await app.invoke("note_tip_feature_used", {
        tipId: "commandPalette",
      });
      assert.deepEqual(used.used, ["commandPalette"]);
      const quiet = await app.invoke("set_tips_auto_show", { enabled: false });
      assert.equal(quiet.auto_show, false);
      assert.equal(quiet.auto_due, false);
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "acct-free",
          paid: false,
          freshLogin: true,
        }),
        false,
        "a free account is never greeted",
      );
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "acct-free",
          paid: true,
          freshLogin: false,
        }),
        true,
        "free to paid is the upgrade the welcome exists for",
      );
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "acct-free",
          paid: true,
          freshLogin: true,
        }),
        false,
        "and it is greeted once",
      );
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "acct-web",
          paid: true,
          freshLogin: true,
        }),
        true,
        "a paid account first seen right after signing in came from checkout",
      );
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "acct-old",
          paid: true,
          freshLogin: false,
        }),
        false,
        "a paid account in an old session is not new to its plan",
      );

      await app.restart();
      const afterRestart = await app.invoke("get_app_settings");
      assert.equal(afterRestart.theme, "dark");
      assert.equal(afterRestart.language, "en");
      assert.equal(afterRestart.onboarding_completed, true);
      assert.deepEqual(afterRestart.tips_seen, ["proxyCheck", "dnsBlocklist"]);
      assert.deepEqual(afterRestart.tips_used, ["commandPalette"]);
      assert.equal(afterRestart.tips_auto_show, false);
      assert.equal(
        afterRestart.tips_next_auto_show_at,
        marked.next_auto_show_at,
        "the wait survives a restart",
      );
      assert.deepEqual((await app.invoke("get_tips_state")).seen, [
        "proxyCheck",
        "dnsBlocklist",
      ]);

      const settingsFile = path.join(
        app.dataRoot,
        "data",
        "settings",
        "app_settings.json",
      );
      const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
      assert.equal(persisted.api_token, null);
    },
    { onboardingCompleted: false },
  );
});

test("two isolated sessions run concurrently and do not share frontend or backend state", async () => {
  const first = appFromEnvironment("smoke-isolation-a");
  const second = appFromEnvironment("smoke-isolation-b");
  try {
    await Promise.all([first.start(), second.start()]);
    const firstSettings = await first.invoke("get_app_settings");
    await first.invoke("save_app_settings", {
      settings: { ...firstSettings, theme: "dark", onboarding_completed: true },
    });
    const secondSettings = await second.invoke("get_app_settings");
    assert.equal(secondSettings.theme, "system");
    assert.notEqual(secondSettings.theme, "dark");

    await first.execute("localStorage.setItem('donut-e2e-only-a', 'yes');");
    assert.equal(
      await second.execute("return localStorage.getItem('donut-e2e-only-a');"),
      null,
      "native WebView data leaked across sessions",
    );
  } catch (error) {
    await Promise.all([first.capture("failure"), second.capture("failure")]);
    throw error;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("keyboard command palette and major navigation surfaces are operable through native WebDriver", async () => {
  await withApp("smoke-ui", async (app) => {
    const modifier =
      process.platform === "darwin" ? { meta: true } : { ctrl: true };
    await app.waitFor(
      async () => {
        await app.pressShortcut({ key: "k", ...modifier });
        return app.execute(
          `return Boolean(document.querySelector("[cmdk-input][placeholder='Type a command or search...']"));`,
        );
      },
      { description: "open command palette" },
    );

    const input = await app.session.findCss("[cmdk-input]");
    await app.session.sendKeys(input, "settings");
    const body = await app.bodyText();
    assert.match(body, /Settings/i);

    // Exercise native WebDriver element marshalling and click, not just script execution.
    // Scoped to the open dialog on purpose: on Linux the app draws its own
    // titlebar, whose "Close window" control appears earlier in the DOM, and
    // clicking that would exercise the window lifecycle instead of the palette.
    const close = await app.execute(
      `const dialog = document.querySelector("[role='dialog']") ?? document;
       return [...dialog.querySelectorAll("button")].find(
        (button) => /close/i.test(button.getAttribute("aria-label") || button.textContent || "")
      ) ?? null;`,
    );
    if (close) {
      await app.session.click(close);
    } else {
      await app.pressShortcut({ key: "Escape" });
    }
  });
});

test("tray labels, hide-to-tray, and confirmed quit follow the native lifecycle", async () => {
  const app = appFromEnvironment("smoke-lifecycle");
  try {
    await app.start();
    await app.invoke("update_tray_menu", {
      showLabel: "Show Donut E2E",
      quitLabel: "Quit Donut E2E",
    });
    await app.invoke("hide_to_tray");
    assert.equal(
      typeof (await app.invoke("get_onboarding_completed")),
      "boolean",
    );

    await app.restart();
    const exitingSession = app.session;
    await app
      .execute(
        `window.__TAURI_INTERNALS__.invoke("confirm_quit").catch(() => {});
         return true;`,
      )
      .catch(() => {});
    await app.waitFor(
      async () => {
        try {
          await exitingSession.title();
          return false;
        } catch {
          return true;
        }
      },
      { timeoutMs: 10_000, description: "confirmed app exit" },
    );
    app.session = null;
    await exitingSession.close().catch(() => {});

    // Agents read this file: each session opens with its facts, closes with
    // what outlives it, and no line repeats the crate name.
    const logDir = path.join(app.dataRoot, "logs");
    const logText = (
      await Promise.all(
        (
          await readdir(logDir)
        )
          .filter((name) => name.endsWith(".log"))
          .map((name) => readFile(path.join(logDir, name), "utf8")),
      )
    ).join("\n");
    assert.match(
      logText,
      /\[app\]\[INFO\] Donut started version=\S+ os="[^"]+" arch=\S+ pid=\d+ /,
    );
    assert.match(
      logText,
      /\[app\]\[INFO\] Donut exiting browsers=\[\] proxy_workers=\[\] vpn_workers=\[\] xray_workers=\[\]/,
    );
    assert.doesNotMatch(logText, /donutbrowser_lib::/);
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
  }
});
