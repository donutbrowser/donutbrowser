import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import Color from "color";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import {
  curlSnippet,
  javascriptSnippet,
  LOCAL_API_EXAMPLES,
  maskToken,
  oneLine,
  REMOTE_MCP_EXAMPLES,
} from "../../src/lib/api-examples.ts";
import { REMOTE_MCP_URL } from "../../src/lib/mcp.ts";
import { getDerivedThemeColors, THEMES } from "../../src/lib/themes.ts";
import { withApp } from "../lib/app.mjs";
import {
  CRX_EXTENSION_NAME,
  CRX_EXTENSION_VERSION,
  extensionZipBase64,
  wireGuardFixture,
  writeUnpackedExtension,
} from "../lib/fixtures.mjs";

const THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
];

const DRACULA_THEME = THEMES.find((theme) => theme.id === "dracula").colors;
const AYU_LIGHT_THEME = THEMES.find((theme) => theme.id === "ayu-light").colors;

async function tableRows(app, tableId) {
  return app.execute(
    `return [...document.querySelectorAll('[data-table-id="' + arguments[0] + '"] tr[data-table-row]')].map(row => row.dataset.tableRow);`,
    [tableId],
  );
}

/** Selection checkboxes, and the browser icons that stand in for them, that sit
 * more than half a pixel off the center of their cell. */
async function offCenterSelectionControls(app, tableSelector) {
  return app.execute(
    `return [...document.querySelectorAll(arguments[0] + ' :is(th, td) :is([data-slot="table-selection"], [role="checkbox"], [role="checkbox"] + [aria-hidden="true"] > svg)')]
       .map((node) => {
         const cell = node.closest("th, td").getBoundingClientRect();
         const rect = node.getBoundingClientRect();
         // The checkbox and the row's icon sit side by side; their group is
         // centered across the cell, and each of them down it.
         const group = node.matches('[data-slot="table-selection"]');
         return {
           control: group ? "selection" : (node.getAttribute("aria-label") ?? "icon"),
           x: group ? rect.left + rect.width / 2 - (cell.left + cell.width / 2) : 0,
           y: rect.top + rect.height / 2 - (cell.top + cell.height / 2),
         };
       })
       .filter(({ x, y }) => Math.abs(x) > 0.5 || Math.abs(y) > 0.5);`,
    [tableSelector],
  );
}

async function tableShiftClick(app, selector) {
  // tauri-wd 0.2.1 omits modifiers from pointer events. Send the click with
  // Shift through the native WebView; the real checkbox handler selects rows.
  await app.execute(
    `const target = document.querySelector(arguments[0]);
     target.focus();
     target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));`,
    [selector],
  );
}

async function openProfileCreation(app) {
  await app.clickText("New", { roles: ["button"] });
  await app.waitForText(en.createProfile.title);
  await app.waitFor(
    () =>
      app.execute(`return Boolean(document.querySelector('#profile-name'));`),
    { description: "profile name field" },
  );
}

async function submitProfileCreation(app, name) {
  await app.clickTextIn('[role="dialog"]', en.common.buttons.create, {
    roles: ["button"],
  });
  await app.waitFor(
    () => app.execute(`return !document.querySelector('#profile-name');`),
    { description: `created profile ${name}` },
  );
  return (await app.invoke("list_browser_profiles")).find(
    (profile) => profile.name === name,
  );
}

test("profile creation stays compact and saves basic, protected, and ephemeral profiles", async () => {
  await withApp(
    "ui-profile-creation",
    async (app) => {
      // The UI suite has no browser binary or live network routes. Record
      // the chosen route, then create locally with a fixed device. The real
      // backend still saves the options and encrypts the profile. The network
      // suite covers creation with a real browser and working proxy.
      await stubCommand(app, "is_geoip_database_available", true);
      await app.execute(`
        const originalFetch = window.fetch;
        window.__donutProfileRequests = [];
        window.fetch = function(input, init) {
          const url = typeof input === 'string' ? input : input?.url ?? '';
          if (url.endsWith('/create_browser_profile_new')) {
            const payload = JSON.parse(init.body);
            window.__donutProfileRequests.push(structuredClone(payload));
            payload.proxyId = null;
            payload.vpnId = null;
            payload.wayfernConfig = { ...payload.wayfernConfig, fingerprint: '{}' };
            return originalFetch.call(window, input, { ...init, body: JSON.stringify(payload) });
          }
          return originalFetch.apply(window, arguments);
        };
      `);
      await app.session.command("POST", "/window/rect", {
        width: 1280,
        height: 900,
      });
      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Simple profile");
      await app.waitFor(
        () =>
          app.execute(
            `return [...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.trim() === arguments[0] && !button.disabled);`,
            [en.common.buttons.create],
          ),
        { description: "creation is available" },
      );
      const basic = await app.execute(`
      const dialog = document.querySelector('#profile-name').closest('[role="dialog"]');
      const rect = dialog.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height,
        text: dialog.innerText,
        tabs: dialog.querySelectorAll('[role="tab"]').length,
        fields: [...dialog.querySelectorAll('input:not([type="hidden"])')].map(input => input.id),
        advancedVisible: Boolean(dialog.querySelector('#launch-hook-url')),
        checkboxes: [...dialog.querySelectorAll('[role="checkbox"]')].map(input => input.id),
      };
    `);
      assert.ok(
        basic.width <= 512 && basic.height < 450,
        JSON.stringify(basic),
      );
      assert.equal(basic.tabs, 0);
      assert.deepEqual(basic.fields, ["profile-name", "profile-count"]);
      assert.deepEqual(basic.checkboxes, ["enable-password", "ephemeral"]);
      assert.equal(basic.advancedVisible, false);
      assert.ok(!basic.text.includes(en.profiles.ephemeralDescription));
      assert.ok(
        !basic.text.includes(en.createProfile.passwordProtect.description),
      );
      const chrome = await app.execute(`
      const dialog = document.querySelector('#profile-name').closest('[role="dialog"]');
      const border = (node) => getComputedStyle(node).borderTopWidth;
      return {
        name: border(document.querySelector('#profile-name')),
        options: [...dialog.querySelectorAll('#profile-proxy, [role="checkbox"]')].map(border),
        proxyName: document.querySelector('#profile-proxy').getAttribute('aria-labelledby')
          .split(' ').map((id) => document.getElementById(id)?.textContent.trim()),
        groupName: document.querySelector('#profile-group').getAttribute('aria-labelledby')
          .split(' ').map((id) => document.getElementById(id)?.textContent.trim()),
      };
    `);
      assert.equal(chrome.name, "0px", "the name field has no box");
      assert.deepEqual(chrome.options, ["0px", "0px", "0px"]);
      assert.deepEqual(chrome.proxyName, [
        en.createProfile.proxy.title,
        en.createProfile.proxy.noProxy,
      ]);
      // The destination group shows as a pill: none while the list shows all.
      assert.deepEqual(chrome.groupName, [
        en.profiles.table.group,
        en.groups.noGroup,
      ]);
      await app.capture("profile-create-compact-wide");
      // The device's operating system is chosen on the dialog itself. Without
      // a plan that includes cross-OS fingerprints, only this computer's
      // system can be picked.
      const hostOs =
        { darwin: "macOS", win32: "Windows" }[process.platform] ?? "Linux";
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-os').textContent.trim();`,
        ),
        hostOs,
      );
      await app.clickSelector("#profile-os");
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelectorAll('[cmdk-item]').length;`,
          ),
        { description: "operating system options" },
      );
      const osOptions = await app.execute(`
      return [...document.querySelectorAll('[cmdk-item]')].map((item) => ({
        text: item.textContent.trim(),
        disabled: item.getAttribute('aria-disabled') === 'true',
      }));
    `);
      assert.equal(osOptions.length, 5, JSON.stringify(osOptions));
      assert.deepEqual(
        osOptions.filter((option) => !option.disabled).map((o) => o.text),
        [hostOs],
      );
      assert.ok(
        osOptions
          .filter((option) => option.disabled)
          .every((option) => option.text.endsWith("PRO")),
        JSON.stringify(osOptions),
      );
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('[cmdk-item]') && Boolean(document.querySelector('#profile-name'));`,
          ),
        { description: "the OS menu to close and the dialog to stay" },
      );
      // Adding a route is part of the route list, and stays there when the
      // search finds nothing.
      await app.clickSelector("#profile-proxy");
      await app.fillSelector("[cmdk-input]", "no such route");
      await app.waitForText(en.createProfile.proxy.notFound);
      await app.clickText(en.createProfile.proxy.addProxy, {
        roles: ["option"],
      });
      await app.waitFor(
        () =>
          app.execute(`return Boolean(document.querySelector('#proxy-name'));`),
        { description: "proxy form from the route list" },
      );
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('#proxy-name') && document.querySelector('#profile-name')?.value === arguments[0];`,
            ["Simple profile"],
          ),
        { description: "creation dialog kept after the proxy form closes" },
      );
      await app.clickSelector("#profile-proxy");
      await app.clickText(en.common.labels.none, { roles: ["option"] });
      const simple = await submitProfileCreation(app, "Simple profile");
      assert.ok(simple);
      assert.equal(simple.ephemeral, false);
      assert.equal(simple.password_protected, false);
      assert.equal(simple.proxy_id, null);
      assert.equal(simple.vpn_id, null);
      assert.ok(simple.wayfern_config.screen_max_width > 0);
      assert.ok(simple.wayfern_config.screen_max_height > 0);

      const proxy = await app.invoke("create_stored_proxy", {
        name: "Creation proxy",
        proxySettings: {
          proxy_type: "http",
          host: "127.0.0.1",
          port: 9,
          username: null,
          password: null,
        },
      });
      const vpn = await app.invoke("create_vpn_config_manual", {
        name: "Creation VPN",
        vpnType: "WireGuard",
        configData: wireGuardFixture(),
      });
      await app.invoke("plugin:event|emit", {
        event: "vpn-configs-changed",
        payload: null,
      });
      const extensions = await app.invoke("create_extension_group", {
        name: "Creation extensions",
      });
      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Protected profile");
      await app.clickSelector("#profile-proxy");
      await app.fillSelector("[cmdk-input]", "Creation proxy");
      await app.clickText(proxy.name, { roles: ["option"] });
      await app.clickSelector("#enable-password");
      await app.fillSelector("#profile-password", "short");
      await app.clickTextIn('[role="dialog"]', en.common.buttons.create, {
        roles: ["button"],
      });
      await app.waitForText(
        en.profilePassword.errors.tooShort.replace("{{min}}", "8"),
      );
      await app.fillSelector("#profile-password", "creation test password");
      await app.fillSelector("#profile-password-confirm", "different password");
      await app.clickTextIn('[role="dialog"]', en.common.buttons.create, {
        roles: ["button"],
      });
      await app.waitForText(en.profilePassword.errors.mismatch);
      await app.fillSelector(
        "#profile-password-confirm",
        "creation test password",
      );
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      await app.fillSelector(
        "#launch-hook-url",
        "https://example.com/hooks/created",
      );
      await chooseSelectOption(
        app,
        "#profile-dns-blocklist",
        en.dnsBlocklist.normal,
      );
      // The DNS field reads the value back from the backend: a value it cannot
      // use blocks creation, a plain address says it is not encrypted, and a
      // preset is encrypted.
      const dnsStatus = (state) =>
        app.waitFor(
          () =>
            app.execute(
              `return document.querySelector('[data-slot="dns-server-status"]')?.dataset.state === arguments[0];`,
              [state],
            ),
          { description: `DNS server status ${state}` },
        );
      const createEnabled = () =>
        app.execute(
          `return [...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.trim() === arguments[0] && !button.disabled);`,
          [en.common.buttons.create],
        );
      await dnsStatus("default");
      await app.waitForText(en.dnsServer.summary.default);
      await app.fillSelector("#profile-dns-server", "udp://1.1.1.1");
      await dnsStatus("invalid");
      await app.waitForText(en.backendErrors.dnsServerInvalid);
      await app.waitFor(async () => !(await createEnabled()), {
        description: "an invalid DNS server blocks creation",
      });
      await app.fillSelector("#profile-dns-server", "10.0.0.53");
      await dnsStatus("valid");
      await app.waitForText(
        en.dnsServer.summary.tcp.replace("{{server}}", "10.0.0.53"),
      );
      await app.clickText("Quad9", { roles: ["button"] });
      await app.waitForText(
        en.dnsServer.summary.https.replace("{{server}}", "dns.quad9.net"),
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-dns-server').value;`,
        ),
        "https://dns.quad9.net/dns-query",
      );
      await app.waitFor(createEnabled, {
        description: "a valid DNS server allows creation",
      });
      await chooseSelectOption(
        app,
        "#profile-extension-group",
        `${extensions.name} (0)`,
      );
      await app.clickSelector("#restore-session");
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-name').closest('[role="dialog"]').querySelectorAll('[role="tab"]').length;`,
        ),
        0,
      );
      await app.execute(
        `document.querySelector('[data-slot="profile-create-fields"]').scrollTop = 0;`,
      );
      await app.capture("profile-create-advanced-wide");
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-name').value;`,
        ),
        "Protected profile",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-password').value;`,
        ),
        "creation test password",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-proxy').textContent.trim();`,
        ),
        proxy.name,
      );
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      assert.equal(
        await app.execute(
          `return document.querySelector('#launch-hook-url').value;`,
        ),
        "https://example.com/hooks/created",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#restore-session').getAttribute('aria-checked');`,
        ),
        "false",
      );
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      await app.session.command("POST", "/window/rect", {
        width: 480,
        height: 700,
      });
      await app.capture("profile-create-password-narrow");
      const fit = await app.execute(`
      const dialog = document.querySelector('#profile-name').closest('[role="dialog"]');
      const rect = dialog.getBoundingClientRect();
      const footer = dialog.querySelector('[data-slot="dialog-footer"]').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight &&
        dialog.scrollWidth <= dialog.clientWidth && footer.bottom <= rect.bottom;
    `);
      assert.equal(fit, true);
      const protectedProfile = await submitProfileCreation(
        app,
        "Protected profile",
      );
      assert.ok(protectedProfile);
      assert.equal(protectedProfile.password_protected, true);
      assert.equal(protectedProfile.ephemeral, false);
      const protectedRequest = await app.execute(
        `return window.__donutProfileRequests.at(-1);`,
      );
      assert.equal(protectedRequest.proxyId, proxy.id);
      assert.equal(protectedRequest.vpnId, undefined);
      assert.equal(protectedProfile.dns_blocklist, "normal");
      assert.equal(
        protectedProfile.dns_server,
        "https://dns.quad9.net/dns-query",
      );
      assert.equal(
        protectedProfile.launch_hook,
        "https://example.com/hooks/created",
      );
      assert.equal(protectedProfile.extension_group_id, extensions.id);
      assert.equal(protectedProfile.wayfern_config.restore_session, false);
      await app.invoke("verify_profile_password", {
        profileId: protectedProfile.id,
        password: "creation test password",
      });

      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Ephemeral profile");
      assert.equal(
        await app.execute(
          `return document.querySelector('#enable-password').getAttribute('aria-checked');`,
        ),
        "false",
      );
      await app.capture("profile-create-compact-narrow");
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      assert.equal(
        await app.execute(
          `return document.querySelector('#launch-hook-url').value;`,
        ),
        "",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-dns-blocklist').textContent.trim();`,
        ),
        en.dnsBlocklist.none,
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-dns-server').value;`,
        ),
        "",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-extension-group').textContent.trim();`,
        ),
        en.profileInfo.values.none,
      );
      await app.capture("profile-create-advanced-narrow");
      await app.clickText(en.createProfile.advancedOptions, {
        roles: ["button"],
      });
      await app.clickSelector("#profile-proxy");
      await app.fillSelector("[cmdk-input]", "Creation VPN");
      await app.clickText(vpn.name, { exact: false, roles: ["option"] });
      await app.clickSelector("#enable-password");
      await app.fillSelector("#profile-password", "discarded password");
      await app.clickSelector("#ephemeral");
      assert.equal(
        await app.execute(
          `return document.querySelector('#enable-password').getAttribute('aria-checked');`,
        ),
        "false",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-password') === null;`,
        ),
        true,
      );
      await app.clickSelector("#enable-password");
      assert.equal(
        await app.execute(
          `return document.querySelector('#ephemeral').getAttribute('aria-checked');`,
        ),
        "false",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#profile-password').value;`,
        ),
        "",
      );
      await app.clickSelector("#ephemeral");
      const ephemeral = await submitProfileCreation(app, "Ephemeral profile");
      assert.ok(ephemeral);
      assert.equal(ephemeral.ephemeral, true);
      assert.equal(ephemeral.password_protected, false);
      const ephemeralRequest = await app.execute(
        `return window.__donutProfileRequests.at(-1);`,
      );
      assert.equal(ephemeralRequest.proxyId, undefined);
      assert.equal(ephemeralRequest.vpnId, vpn.id);
      assert.equal(ephemeral.launch_hook, null);
    },
    { seedDownloadedBrowser: true },
  );
});

test("profile table filters, range selection, view settings, and keyboard edits work together", async () => {
  await withApp(
    "ui-table-controls",
    async (app) => {
      await app.session.command("POST", "/window/rect", {
        width: 1480,
        height: 900,
      });
      const profiles = [];
      for (let i = 0; i < 32; i++)
        profiles.push(
          await createUiProfile(app, `Table ${String(i + 1).padStart(2, "0")}`),
        );
      for (const profile of profiles.slice(0, 2))
        await app.invoke("update_profile_tags", {
          profileId: profile.id,
          tags: ["table-work"],
        });
      await app.waitFor(
        async () => (await tableRows(app, "profiles")).length >= 4,
        { description: "profile table rows" },
      );
      const chrome = await app.execute(
        `
        const root = document.querySelector('[data-table-id="profiles"]');
        const border = (node) => getComputedStyle(node).borderTopWidth;
        const filters = [...root.querySelectorAll('[data-slot="table-filters"] button')]
          .find((button) => button.textContent.trim() === arguments[0]);
        return {
          controls: [
            filters,
            root.querySelector('[data-slot="table-sort-trigger"]'),
            root.querySelector('[data-slot="table-view-trigger"]'),
          ].map(border),
          rowRules: [...root.querySelectorAll('tr[data-table-row] > td')]
            .filter((cell) => parseFloat(getComputedStyle(cell).borderBottomWidth) > 0).length,
        };
      `,
        [en.tables.filters],
      );
      assert.deepEqual(chrome.controls, ["0px", "0px", "0px"]);
      assert.equal(chrome.rowRules, 0, "rows are not divided by rules");
      assert.deepEqual(
        await offCenterSelectionControls(app, '[data-table-id="profiles"]'),
        [],
      );
      const row = (index) => `tr[data-table-row="${profiles[index].id}"]`;
      // A new profile is scrolled into view, so the last of the 32 leaves the
      // table at its end. Scroll back to the first row.
      await app.waitFor(
        () =>
          app.execute(
            `
            const root = document.querySelector('[data-table-id="profiles"]');
            if (root?.querySelector('table')?.getAttribute('aria-rowcount') !== "33") return false;
            root.querySelector('.scroll-fade').scrollTop = 0;
            return Boolean(root.querySelector(arguments[0]));
          `,
            [row(0)],
          ),
        { description: "the first profile row in view" },
      );
      await app.clickSelector(`${row(0)} [role="checkbox"]`);
      await tableShiftClick(app, `${row(3)} [role="checkbox"]`);
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelectorAll('tr[data-table-row][aria-selected="true"]').length === 4;`,
          ),
        { description: "Shift-click selects four rows" },
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('[data-table-id="profiles"] thead [role="checkbox"]').getAttribute('data-state');`,
        ),
        "indeterminate",
      );
      assert.match(
        await app.execute(
          `return document.querySelector('[data-slot="table-action-bar"]').textContent;`,
        ),
        /4/,
      );
      const searchSelector = `input[placeholder="${en.header.searchPlaceholder}"]`;
      // Quoted: an unquoted "02" is its own term, which also prefix-matches
      // any profile whose random id starts with 02.
      await app.fillSelector(searchSelector, '"Table 02"');
      await app.waitFor(
        async () =>
          JSON.stringify(await tableRows(app, "profiles")) ===
          JSON.stringify([profiles[1].id]),
        { description: "profile text search" },
      );
      // The selection outlives the search; the bar counts what it hides.
      assert.ok(
        (
          await app.execute(
            `return document.querySelector('[data-slot="table-action-bar"]')?.textContent ?? "";`,
          )
        ).includes(
          en.dataTableActionBar.selectedHidden
            .replace("{{selected}}", "4")
            .replace("{{hidden}}", "3"),
        ),
        "the bar counts the selected rows the search hides",
      );
      await app.clickSelector(
        `[data-slot="table-action-bar"] [aria-label="${en.dataTableActionBar.clearSelection}"]`,
      );
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('[data-slot="table-action-bar"]');`,
          ),
        { description: "clearing the selection removes the bar" },
      );
      const searchValue = () =>
        app.execute("return document.querySelector(arguments[0]).value;", [
          searchSelector,
        ]);
      const searchGhost = () =>
        app.execute(
          `return document.querySelector('[data-slot="profile-search-ghost"]')?.textContent ?? "";`,
        );
      const suggestionsOpen = () =>
        app.execute(
          `return Boolean(document.querySelector('[data-slot="profile-search-suggestions"]'));`,
        );
      await app.clickSelector(`[aria-label="${en.header.clearSearch}"]`);
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelectorAll('[data-slot="profile-search-suggestions"] [role="option"][data-suggestion-kind="example"]').length === arguments[0];`,
            [3],
          ),
        { description: "an emptied search lists example queries" },
      );
      await app.pressShortcut({ key: "\uE00C" });
      await app.waitFor(async () => !(await suggestionsOpen()), {
        description: "Escape closes the suggestions",
      });

      // Ghost completion: a field name, then a value from the profiles' tags.
      await app.fillSelector(searchSelector, "ta");
      await app.waitFor(async () => (await searchGhost()) === "g:", {
        description: "field name ghost text",
      });
      await app.pressShortcut({ key: "\uE004" });
      await app.waitFor(async () => (await searchValue()) === "tag:", {
        description: "Tab accepts the field name",
      });
      await app.waitFor(async () => (await searchGhost()) === "table-work", {
        description: "tag value ghost text",
      });
      await app.pressShortcut({ key: "\uE004" });
      await app.waitFor(
        async () =>
          (await searchValue()) === "tag:table-work " &&
          (await tableRows(app, "profiles")).length === 2,
        { description: "Tab accepts the tag value" },
      );
      const highlight = await app.execute(
        `
        const input = document.querySelector(arguments[0]);
        const layer = document.querySelector('[data-slot="profile-search-highlight"]');
        const field = [...layer.children].find((node) => node.textContent === "tag:");
        return {
          mirrored: layer.textContent === input.value,
          inputText: getComputedStyle(input).color,
          field: field ? getComputedStyle(field).color : null,
          value: getComputedStyle([...layer.children].find((node) => node.textContent === "table-work")).color,
        };
      `,
        [searchSelector],
      );
      assert.equal(highlight.mirrored, true, "the highlight mirrors the input");
      assert.equal(highlight.inputText, "rgba(0, 0, 0, 0)");
      assert.ok(highlight.field, "the field name is its own span");
      assert.notEqual(
        highlight.field,
        highlight.value,
        "field and value differ",
      );
      assert.equal(
        await suggestionsOpen(),
        false,
        "a finished term closes the list",
      );

      // Picking a value with the mouse, and with the arrow keys.
      await app.fillSelector(searchSelector, "tag:");
      const option =
        '[data-slot="profile-search-suggestions"] [role="option"][data-suggestion="table-work"]';
      await app.waitFor(
        () =>
          app.execute(
            "return document.querySelector(arguments[0])?.textContent === '2';",
            [`${option} [data-slot="profile-search-count"]`],
          ),
        { description: "tag value with its profile count" },
      );
      await app.clickSelector(option);
      await app.waitFor(
        async () =>
          (await searchValue()) === "tag:table-work " &&
          (await tableRows(app, "profiles")).length === 2,
        { description: "a clicked suggestion fills the value" },
      );
      await app.fillSelector(searchSelector, "tag:");
      await app.waitFor(suggestionsOpen, { description: "tag values listed" });
      await app.pressShortcut({ key: "\uE015" });
      await app.waitFor(
        () =>
          app.execute(
            "return document.getElementById(document.querySelector(arguments[0]).getAttribute('aria-activedescendant'))?.dataset.suggestion === 'table-work';",
            [searchSelector],
          ),
        { description: "ArrowDown chooses the first value" },
      );
      await app.pressShortcut({ key: "\uE007" });
      await app.waitFor(
        async () => (await searchValue()) === "tag:table-work ",
        {
          description: "Enter accepts the chosen suggestion",
        },
      );

      // A value the field cannot take is explained in the list.
      await app.fillSelector(searchSelector, "os:solaris");
      await app.waitFor(
        () =>
          app
            .execute(
              `return document.querySelector('[data-slot="profile-search-issue"]')?.textContent ?? "";`,
            )
            .then(
              (text) =>
                text ===
                en.search.issues.enum
                  .replace("{{field}}", "os:")
                  .replace("{{values}}", "macos, windows, linux"),
            ),
        { description: "an invalid enum value explains itself" },
      );

      // The syntax help inserts a field where the caret is.
      await app.clickSelector(`[aria-label="${en.header.clearSearch}"]`);
      await app.clickSelector(`[aria-label="${en.search.helpLabel}"]`);
      await app.clickSelector(
        '[data-slot="profile-search-help"] [data-search-field="group"]',
      );
      await app.waitFor(
        async () =>
          (await searchValue()) === "group:" &&
          (await app.execute(
            "return document.activeElement === document.querySelector(arguments[0]);",
            [searchSelector],
          )),
        { description: "the help inserts a field and returns to the box" },
      );
      await app.clickSelector(`[aria-label="${en.header.clearSearch}"]`);
      await app.pressShortcut({ key: "\uE00C" });
      await app.clickTextIn(
        '[data-table-id="profiles"] [data-slot="table-filters"]',
        en.tables.filters,
        { roles: ["button"] },
      );
      await app.clickSelector(
        `[cmdk-item][data-value="${en.profileTable.tagsHeader} table-work"]`,
      );
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        async () => (await tableRows(app, "profiles")).length === 2,
        { description: "visible tag filter" },
      );
      assert.match(
        await app.execute(
          `return document.querySelector('[data-slot="table-result-count"]').textContent;`,
        ),
        /2.*32/,
      );
      await app.clickTextIn(
        '[data-table-id="profiles"] [data-slot="table-filters"]',
        en.tables.clearFilters,
        { roles: ["button"] },
      );

      await app.clickSelector(
        '[data-table-id="profiles"] [data-slot="table-sort-trigger"]',
      );
      await app.clickText(en.tables.addSort, { roles: ["button"] });
      await app.clickSelector(
        `[data-sort-index="1"] button[aria-label="${en.tables.moveSortUp}"]`,
      );
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        async () =>
          (await app.invoke("get_table_preferences", { tableId: "profiles" }))
            .sorting[0].id === "created_at",
        { description: "ordered sort rules saved" },
      );
      assert.match(
        await app.execute(
          `return document.querySelector('[data-slot="table-sort-trigger"]').textContent;`,
        ),
        new RegExp(en.search.fields.created),
      );

      await app.clickSelector(
        '[data-table-id="profiles"] [data-slot="table-view-trigger"]',
      );
      await app.clickSelector("#table-visible-profiles-note");
      await app.clickSelector(`[aria-label="${en.tables.rowHeight}"]`);
      await app.clickText(en.tables.comfortable, { roles: ["option"] });
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        async () =>
          (await app.invoke("get_table_preferences", { tableId: "profiles" }))
            .density === "comfortable",
        { description: "comfortable rows saved" },
      );
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('[data-table-column="note"]'));`,
        ),
        false,
      );
      assert.equal(
        await app.execute(
          `return Math.round(document.querySelector('tr[data-table-row]').getBoundingClientRect().height);`,
        ),
        48,
      );
      const resizeName = `[data-table-id="profiles"] [role="separator"][aria-label="${en.tables.resizeColumn.replace("{{column}}", en.common.labels.name)}"]`;
      const columnWidth = () =>
        app.execute(
          `return document.querySelector(arguments[0]).parentElement.getBoundingClientRect().width;`,
          [resizeName],
        );
      const initialWidth = await columnWidth();
      await app.execute(`document.querySelector(arguments[0]).focus();`, [
        resizeName,
      ]);
      await app.pressShortcut({ key: "\uE014" });
      await app.waitFor(
        async () =>
          (await app.invoke("get_table_preferences", { tableId: "profiles" }))
            .sizing.name > 48,
        { description: "keyboard column resize saved" },
      );
      const saved = await app.invoke("get_table_preferences", {
        tableId: "profiles",
      });
      assert.ok(Math.abs((await columnWidth()) - initialWidth - 16) < 2);
      assert.ok(Math.abs((await columnWidth()) - saved.sizing.name) < 2);
      await app.capture("table-controls-wide");
      await app.restart();
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('tr[data-table-row]')?.getBoundingClientRect().height === 48;`,
          ),
        { description: "saved view restored after restart" },
      );
      assert.deepEqual(
        await app.invoke("get_table_preferences", { tableId: "profiles" }),
        saved,
      );
      assert.ok(Math.abs((await columnWidth()) - saved.sizing.name) < 2);

      await app.clickSelector(
        '[data-table-id="profiles"] [data-slot="table-view-trigger"]',
      );
      await app.clickText(en.tables.resetView, { roles: ["button"] });
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('tr[data-table-row]')?.getBoundingClientRect().height === 36;`,
          ),
        { description: "default view restored" },
      );
      await app.session.command("POST", "/window/rect", {
        width: 1280,
        height: 500,
      });
      await app.waitFor(
        () =>
          app.execute(`return !document.querySelector(arguments[0]);`, [
            row(24),
          ]),
        { description: "keyboard target starts outside the rendered rows" },
      );
      await app.execute(`document.querySelector(arguments[0]).focus();`, [
        `${row(0)} [data-table-column="name"]`,
      ]);
      for (let i = 0; i < 24; i++) {
        await app.pressShortcut({ key: "\uE015" });
        await app.waitFor(
          () =>
            app.execute(
              `return document.activeElement?.closest('tr')?.dataset.tableRow === arguments[0];`,
              [profiles[i + 1].id],
            ),
          { description: `keyboard row ${i + 2}` },
        );
      }
      await app.waitFor(
        () =>
          app.execute(
            `return document.activeElement?.closest('tr')?.dataset.tableRow === arguments[0];`,
            [profiles[24].id],
          ),
        { description: "keyboard crosses the virtual row boundary" },
      );
      await app.pressShortcut({ key: "\uE032" });
      await app.fillSelector(`${row(24)} input`, "Table renamed by keyboard");
      await app.pressShortcut({ key: "\uE006" });
      await app.waitFor(
        async () =>
          (await app.invoke("list_browser_profiles")).find(
            (profile) => profile.id === profiles[24].id,
          )?.name === "Table renamed by keyboard",
        { description: "F2 edit saved through the backend" },
      );
      await app.session.command("POST", "/window/rect", {
        width: 640,
        height: 600,
      });
      await app.capture("table-controls-narrow");
      assert.equal(
        await app.execute(
          `return document.documentElement.scrollWidth <= innerWidth;`,
        ),
        true,
        "controls do not widen the window",
      );
      await app.clickSelector(
        '[data-table-id="profiles"] thead [role="checkbox"]',
      );
      await app.waitFor(
        () =>
          app.execute(
            `
            const scroll = document.querySelector('[data-table-id="profiles"] .scroll-fade');
            scroll.scrollTop = scroll.scrollHeight;
            const rows = [...scroll.querySelectorAll('tr[data-table-row]')];
            const bar = document.querySelector('[data-slot="table-action-bar"]');
            return rows.at(-1)?.dataset.tableRow === arguments[0] &&
              rows.at(-1).getBoundingClientRect().bottom <= bar?.getBoundingClientRect().top - 4;
          `,
            [profiles[24].id],
          ),
        { description: "last row clears the wrapped bulk action bar" },
      );
      await app.capture("table-controls-narrow-selection");
    },
    { seedDownloadedBrowser: true },
  );
});

test("a proxy with a change-IP link offers Change IP on its row", async () => {
  await withApp("ui-proxy-rotation", async (app) => {
    const linked = await app.invoke("create_stored_proxy", {
      name: "Rotating mobile proxy",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 9,
        username: null,
        password: null,
      },
    });
    await app.invoke("set_proxy_rotation_url", {
      proxyId: linked.id,
      rotationUrl: `${process.env.DONUT_E2E_FIXTURE_URL}/change-ip?key=ui`,
    });
    const plain = await app.invoke("create_stored_proxy", {
      name: "Static proxy",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 9,
        username: null,
        password: null,
      },
    });
    // Mod+Shift+N opens Network; plain Mod+N makes a new profile.
    await app.pressShortcut({
      key: "n",
      shift: true,
      ...(process.platform === "darwin" ? { meta: true } : { ctrl: true }),
    });
    await app.waitFor(
      async () => (await tableRows(app, "proxies")).length === 2,
      { description: "proxy table" },
    );
    const rotateIn = (id) =>
      `[data-table-id="proxies"] tr[data-table-row="${id}"] [data-slot="proxy-rotate"]`;
    assert.equal(
      await app.execute(
        "return Boolean(document.querySelector(arguments[0]));",
        [rotateIn(plain.id)],
      ),
      false,
      "a proxy without a link has no Change IP action",
    );
    await app.clickSelector(rotateIn(linked.id));
    await app.waitForText(
      en.proxies.rotation.requested.replace("{{name}}", linked.name),
    );
    await app.capture("proxy-rotation-requested");
  });
});

test("management tables share search, filters, selection, and saved views", async () => {
  await withApp("ui-management-tables", async (app) => {
    const proxies = [];
    for (const [name, protocol] of [
      ["Table proxy Alpha", "http"],
      ["Table proxy Beta", "socks5"],
      ["Table proxy Gamma", "http"],
    ])
      proxies.push(
        await app.invoke("create_stored_proxy", {
          name,
          proxySettings: {
            proxy_type: protocol,
            host: "127.0.0.1",
            port: 9,
            username: null,
            password: null,
          },
        }),
      );
    await app.invoke("create_profile_group", { name: "Table group Alpha" });
    await app.invoke("create_profile_group", { name: "Table group Beta" });
    // Mod+Shift+N opens Network; plain Mod+N makes a new profile.
    await app.pressShortcut({
      key: "n",
      shift: true,
      ...(process.platform === "darwin" ? { meta: true } : { ctrl: true }),
    });
    await app.waitFor(
      async () => (await tableRows(app, "proxies")).length === 3,
      { description: "proxy table" },
    );
    assert.deepEqual(
      await offCenterSelectionControls(app, '[data-table-id="proxies"]'),
      [],
    );
    const proxyRowHeight = () =>
      app.execute(
        `return document.querySelector('[data-table-id="proxies"] tr[data-table-row]')?.getBoundingClientRect().height;`,
      );
    await app.clickSelector(
      `[data-table-id="proxies"] tr[data-table-row="${proxies[0].id}"] [role="checkbox"]`,
    );
    await tableShiftClick(
      app,
      `[data-table-id="proxies"] tr[data-table-row="${proxies[2].id}"] [role="checkbox"]`,
    );
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelectorAll('[data-table-id="proxies"] tr[aria-selected="true"]').length === 3;`,
        ),
      { description: "management range selection" },
    );
    await app.fillSelector(
      `[data-table-id="proxies"] input[aria-label="${en.tables.search}"]`,
      "Beta",
    );
    await app.waitFor(
      async () => (await tableRows(app, "proxies")).length === 1,
      { description: "proxy search" },
    );
    // A search keeps the selection, and the bar counts the rows it hides.
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector('[data-slot="table-action-bar"] [data-slot="table-selection-count"] .sr-only')?.textContent === arguments[0];`,
          [
            en.dataTableActionBar.selectedHidden
              .replace("{{selected}}", "3")
              .replace("{{hidden}}", "2"),
          ],
        ),
      { description: "selection kept through the search" },
    );
    await app.clickSelector(
      `[data-slot="table-action-bar"] [aria-label="${en.dataTableActionBar.clearSelection}"]`,
    );
    await app.waitFor(
      () =>
        app.execute(
          `return !document.querySelector('[data-slot="table-action-bar"]');`,
        ),
      { timeoutMs: 2000, description: "selection cleared" },
    );
    await app.fillSelector(
      `[data-table-id="proxies"] input[aria-label="${en.tables.search}"]`,
      "no such row",
    );
    await app.waitForText(en.tables.noResults);
    await app.clickTextIn(
      '[data-table-id="proxies"] tbody',
      en.tables.clearFilters,
      { roles: ["button"] },
    );
    assert.equal((await tableRows(app, "proxies")).length, 3);
    await app.clickTextIn(
      '[data-table-id="proxies"] [data-slot="table-filters"]',
      en.tables.filters,
      { roles: ["button"] },
    );
    await app.clickSelector(
      `[cmdk-item][data-value="${en.proxies.management.protocolCol} HTTP"]`,
    );
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(
      async () => (await tableRows(app, "proxies")).length === 2,
      { description: "proxy protocol facet" },
    );
    await app.clickSelector(
      '[data-table-id="proxies"] [data-slot="table-view-trigger"]',
    );
    await app.clickSelector("#table-visible-proxies-hostPort");
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(
      async () =>
        (await app.invoke("get_table_preferences", { tableId: "proxies" }))
          .visibility.hostPort === false,
      { description: "management columns saved" },
    );
    assert.equal(await proxyRowHeight(), 36);
    await app.clickSelector(
      '[data-table-id="proxies"] [data-slot="table-view-trigger"]',
    );
    await app.clickSelector(`[aria-label="${en.tables.rowHeight}"]`);
    await app.clickText(en.tables.comfortable, { roles: ["option"] });
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(async () => (await proxyRowHeight()) === 48, {
      description: "management row height changes",
    });
    await app.capture("management-table-controls");
    await app.clickSelector(`[aria-label="${en.rail.groups}"]`);
    await app.waitFor(
      async () => (await tableRows(app, "groups")).length === 2,
      { description: "group table" },
    );
    await app.fillSelector(
      `[data-table-id="groups"] input[aria-label="${en.tables.search}"]`,
      "Beta",
    );
    await app.waitFor(
      async () => (await tableRows(app, "groups")).length === 1,
      { description: "group search" },
    );
    await app.invoke("create_vpn_config_manual", {
      name: "Table VPN Alpha",
      vpnType: "WireGuard",
      configData: wireGuardFixture(),
    });
    await app.invoke("create_vpn_config_manual", {
      name: "Table VPN Beta",
      vpnType: "WireGuard",
      configData: wireGuardFixture(),
    });
    await app.clickSelector(`[aria-label="${en.rail.network}"]`);
    await app.clickText(en.proxies.management.tabVpns, {
      roles: ["tab"],
      exact: false,
    });
    await app.waitFor(async () => (await tableRows(app, "vpns")).length === 2, {
      description: "VPN table",
    });
    await app.fillSelector(
      `[data-table-id="vpns"] input[aria-label="${en.tables.search}"]`,
      "Beta",
    );
    await app.waitFor(async () => (await tableRows(app, "vpns")).length === 1, {
      description: "VPN search",
    });
    await app.invoke("add_extension", {
      name: "Table extension",
      fileName: "fixture.zip",
      fileData: [...Buffer.from(extensionZipBase64(), "base64")],
    });
    await app.invoke("create_extension_group", {
      name: "Table extension group Alpha",
    });
    await app.invoke("create_extension_group", {
      name: "Table extension group Beta",
    });
    await app.clickSelector(`[aria-label="${en.rail.extensions}"]`);
    await app.waitFor(
      async () => (await tableRows(app, "extensions")).length === 1,
      { description: "extension table" },
    );
    await app.fillSelector(
      `[data-table-id="extensions"] input[aria-label="${en.tables.search}"]`,
      "no such extension",
    );
    await app.waitForText(en.tables.noResults);
    await app.clickTextIn(
      '[data-table-id="extensions"] tbody',
      en.tables.clearFilters,
      { roles: ["button"] },
    );
    await app.clickText(en.extensions.groupsTab, {
      roles: ["tab"],
      exact: false,
    });
    await app.waitFor(
      async () => (await tableRows(app, "extensionGroups")).length === 2,
      { description: "extension group table" },
    );
    await app.fillSelector(
      `[data-table-id="extensionGroups"] input[aria-label="${en.tables.search}"]`,
      "Beta",
    );
    await app.waitFor(
      async () => (await tableRows(app, "extensionGroups")).length === 1,
      { description: "extension group search" },
    );
  });
});

async function dismissSurface(app) {
  await app.pressShortcut({ key: "Escape" });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function themeSnapshot(app) {
  return app.execute(
    `
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);
      const bodyStyle = getComputedStyle(document.body);
      const variables = arguments[0];
      return {
        mode: root.classList.contains("light")
          ? "light"
          : root.classList.contains("dark")
            ? "dark"
            : "unset",
        inline: Object.fromEntries(
          variables.map((key) => [key, root.style.getPropertyValue(key).trim()])
        ),
        resolved: Object.fromEntries(
          variables.map((key) => [key, rootStyle.getPropertyValue(key).trim()])
        ),
        bodyBackground: bodyStyle.backgroundColor,
        bodyForeground: bodyStyle.color,
      };
    `,
    [THEME_VARIABLES],
  );
}

async function waitForTheme(app, predicate, description) {
  return app.waitFor(
    async () => {
      const snapshot = await themeSnapshot(app);
      return predicate(snapshot) ? snapshot : false;
    },
    { description },
  );
}

function themeVariablesEqual(actual, expected) {
  return THEME_VARIABLES.every(
    (key) => actual[key]?.toLowerCase() === expected[key]?.toLowerCase(),
  );
}

async function applyThemeForContrastAudit(app, theme) {
  await app.execute(
    `
      // This audit reads settled colour tokens, not the animation between
      // them. Tab triggers carry "transition-colors duration-150" and start
      // from --muted-foreground, so a computed style sampled mid-transition
      // returns an intermediate colour and the assertion fails on whichever
      // theme the machine happened to be slow on. Kill transitions for the
      // duration of the audit rather than racing them with a fixed sleep.
      let freeze = document.getElementById("donut-e2e-freeze-transitions");
      if (!freeze) {
        freeze = document.createElement("style");
        freeze.id = "donut-e2e-freeze-transitions";
        freeze.textContent =
          "*, *::before, *::after { transition: none !important; animation: none !important; }";
        document.head.appendChild(freeze);
      }

      const [colors, derived, mode] = arguments;
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(mode);
      for (const [key, value] of Object.entries({ ...colors, ...derived })) {
        root.style.setProperty(key, value, "important");
      }
    `,
    [theme.colors, getDerivedThemeColors(theme.colors), theme.mode],
  );
  // One frame is enough once transitions are off; the value cannot drift after
  // style recalculation.
  await app.execute(
    `return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));`,
  );
}

async function animatedTabContrastSnapshot(app) {
  return app.execute(`
    const rootStyle = getComputedStyle(document.documentElement);
    const triggers = [
      ...document.querySelectorAll('[data-slot="animated-tabs-trigger"]'),
    ];
    const active = triggers.find(
      (trigger) => trigger.getAttribute("data-state") === "active",
    );
    const inactive = triggers.find(
      (trigger) => trigger.getAttribute("data-state") === "inactive",
    );
    const content = (trigger) =>
      [...(trigger?.children ?? [])].filter(
        (child) =>
          child.getAttribute("data-slot") !== "animated-tabs-indicator",
      );
    const activeContent = content(active);
    const inactiveContent = content(inactive);
    const indicator = active?.querySelector(
      '[data-slot="animated-tabs-indicator"]',
    );
    return {
      mode: document.documentElement.classList.contains("light")
        ? "light"
        : "dark",
      background: rootStyle.getPropertyValue("--background").trim(),
      accent: rootStyle.getPropertyValue("--accent").trim(),
      accentForeground: rootStyle
        .getPropertyValue("--accent-foreground")
        .trim(),
      mutedForeground: rootStyle
        .getPropertyValue("--muted-foreground")
        .trim(),
      activeTitle: activeContent[0]
        ? getComputedStyle(activeContent[0]).color
        : null,
      activeCount: activeContent[1]
        ? getComputedStyle(activeContent[1]).color
        : null,
      activeBackground: indicator
        ? getComputedStyle(indicator).backgroundColor
        : null,
      inactiveTitle: inactiveContent[0]
        ? getComputedStyle(inactiveContent[0]).color
        : null,
      inactiveCount: inactiveContent[1]
        ? getComputedStyle(inactiveContent[1]).color
        : null,
    };
  `);
}

function assertColorEquals(actual, expected, description) {
  assert.ok(actual, `${description} is missing`);
  assert.equal(Color(actual).hex(), Color(expected).hex(), description);
}

function assertContrast(foreground, background, minimum, description) {
  assert.ok(foreground, `${description} foreground is missing`);
  assert.ok(background, `${description} background is missing`);
  const ratio = Color(foreground).contrast(Color(background));
  assert.ok(
    ratio >= minimum,
    `${description} is ${ratio.toFixed(2)}:1; expected at least ${minimum}:1`,
  );
}

async function chooseSelectOption(app, triggerSelector, option) {
  await app.waitFor(
    () =>
      app.execute(
        `const trigger = document.querySelector(arguments[0]);
         if (!trigger || trigger.matches(":disabled")) return false;
         trigger.focus();
         return document.activeElement === trigger;`,
        [triggerSelector],
      ),
    { description: `enabled select ${triggerSelector}` },
  );
  await app.pressShortcut({ key: "\uE007" });
  await app.waitFor(
    () =>
      app.execute(
        `const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === arguments[0]);
         option?.focus();
         return option && document.activeElement === option;`,
        [option],
      ),
    { description: `select option ${option}` },
  );
  await app.pressShortcut({ key: "\uE007" });
  await app.waitFor(
    () =>
      app.execute(
        `return document.querySelector(arguments[0])?.textContent.includes(arguments[1]);`,
        [triggerSelector, option],
      ),
    { description: `selected value ${option}` },
  );
}

async function chooseThemeCard(app, slotName, value) {
  const card = `[data-slot="${slotName}"][data-value="${value}"]`;
  await app.clickSelector(card);
  await app.waitFor(
    () =>
      app.execute(
        `return document.querySelector(arguments[0])?.getAttribute("aria-checked") === "true";`,
        [card],
      ),
    { description: `${value} chosen in ${slotName}` },
  );
}

function checkedThemeCard(app, slotName) {
  return app.execute(
    `return document.querySelector('[data-slot="' + arguments[0] + '"][aria-checked="true"]')?.dataset.value ?? null;`,
    [slotName],
  );
}

async function saveSettings(app) {
  await app.clickText("Save settings", { roles: ["button"] });
  await app.waitFor(
    () =>
      app.execute(
        `return document.querySelector('[data-slot="settings-feedback"]')?.textContent.includes("Saved");`,
      ),
    { description: "Settings to confirm the saved values" },
  );
}

async function assertThemeAcrossNavigation(app, expected) {
  for (const surface of ["Network", "Extensions", "Profiles"]) {
    await app.clickSelector(`[aria-label="${surface}"]`);
    await app.waitFor(
      async () =>
        JSON.stringify(await themeSnapshot(app)) === JSON.stringify(expected),
      { description: `theme to remain unchanged on ${surface}` },
    );
  }
}

async function dragBackgroundColorPicker(app) {
  await app.clickSelector('[aria-label="Background"]');
  const drag = await app.waitFor(
    () =>
      app.execute(`
        const popover = document.querySelector('[data-slot="popover-content"]');
        const selection = [...(popover?.querySelectorAll("div") ?? [])].find(
          (node) => node.style.background.includes("linear-gradient")
        );
        if (!selection) return null;
        const rect = selection.getBoundingClientRect();
        const points = [];
        for (const yf of [0.2, 0.4, 0.6, 0.8]) {
          for (const xf of [0.2, 0.4, 0.6, 0.8]) {
            const point = {
              x: Math.round(rect.left + rect.width * xf),
              y: Math.round(rect.top + rect.height * yf),
            };
            const hit = document.elementFromPoint(point.x, point.y);
            if (hit === selection || selection.contains(hit)) points.push(point);
          }
        }
        return points.length >= 2
          ? { start: points[0], end: points[points.length - 1] }
          : null;
      `),
    { description: "two pointer-interactive background color picker points" },
  );
  await app.execute(`
    window.__donutE2eThemePointerEvents = [];
    for (const type of ["pointermove", "pointerdown", "pointerup"]) {
      window.addEventListener(type, (event) => {
        window.__donutE2eThemePointerEvents.push({
          type,
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
          target: event.target?.className ?? event.target?.tagName ?? "",
        });
      }, true);
    }
  `);
  await app.session.command("POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "theme-color-pointer",
        actions: [
          {
            type: "pointerMove",
            x: drag.start.x,
            y: drag.start.y,
            origin: "viewport",
          },
          { type: "pointerDown", button: 0 },
          { type: "pause", duration: 150 },
          {
            type: "pointerMove",
            x: drag.end.x,
            y: drag.end.y,
            duration: 100,
            origin: "viewport",
          },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
  const pointerEvents = await app.execute(
    `return window.__donutE2eThemePointerEvents ?? [];`,
  );
  assert.equal(pointerEvents[0]?.type, "pointermove");
  assert.equal(pointerEvents[1]?.type, "pointerdown");
  assert.equal(pointerEvents.at(-1)?.type, "pointerup");
  const dragMoves = pointerEvents.slice(2, -1);
  assert.ok(dragMoves.length >= 1);
  assert.ok(dragMoves.every((event) => event.type === "pointermove"));
  assert.match(pointerEvents[1].target, /cursor-pointer/);
  assert.match(dragMoves.at(-1).target, /cursor-pointer/);
  assert.equal(dragMoves.at(-1).buttons, 1);
  await app.waitFor(
    () =>
      app.execute(
        `return document.querySelector('[data-slot="settings-theme-preset"][data-value="custom"]')?.getAttribute("aria-checked") === "true";`,
      ),
    {
      description: `customized theme to be marked as Your Own after ${JSON.stringify(pointerEvents)}`,
    },
  );
  await app.clickSelector('[aria-label="Background"]');
  await app.waitFor(
    () =>
      app.execute(
        `return document.querySelector('[data-slot="popover-content"]') === null;`,
      ),
    { description: "color picker to close" },
  );
}

async function paintedColors(app, probes) {
  return app.execute(
    `
      // Computed tints come back as color-mix() results with alpha. Paint
      // them over the page on a 1px canvas to read the colour a person sees.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const sentinel = "#010203";
      const flatten = (layers) => {
        context.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          context.fillStyle = sentinel;
          context.fillStyle = layer;
          if (context.fillStyle === sentinel) return null;
          context.fillRect(0, 0, 1, 1);
        }
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return "rgb(" + r + ", " + g + ", " + b + ")";
      };
      const page = getComputedStyle(document.body).backgroundColor;
      const result = { page: flatten([page]) };
      for (const [name, [selector, text]] of Object.entries(arguments[0])) {
        const node = [...document.querySelectorAll(selector)].find(
          (candidate) => !text || candidate.textContent.trim() === text,
        );
        if (!node) {
          result[name] = null;
          continue;
        }
        const style = getComputedStyle(node);
        result[name] = {
          fill: flatten([page, style.backgroundColor]),
          text: flatten([page, style.backgroundColor, style.color]),
        };
      }
      return result;
    `,
    [probes],
  );
}

function assertQuietTint(painted, page, maximum, description) {
  assert.ok(painted, `${description} is missing`);
  const ratio = Color(painted.fill).contrast(Color(page));
  assert.ok(
    ratio >= 1.03 && ratio <= maximum,
    `${description} tint is ${ratio.toFixed(2)}:1 against the page; expected 1.03 to ${maximum}`,
  );
  assertContrast(painted.text, painted.fill, 4.5, `${description} text`);
}

test("soft table and creation surfaces stay quiet and readable in every theme", async () => {
  await withApp(
    "ui-soft-surfaces",
    async (app) => {
      await app.session.command("POST", "/window/rect", {
        width: 1280,
        height: 860,
      });
      const tagged = await createUiProfile(app, "Theme Alpha");
      await createUiProfile(app, "Theme Beta");
      await app.invoke("update_profile_tags", {
        profileId: tagged.id,
        tags: ["theme-tag"],
      });
      await app.waitFor(
        async () => (await tableRows(app, "profiles")).length === 2,
        { description: "theme table rows" },
      );
      await app.clickSelector(
        `tr[data-table-row="${tagged.id}"] [role="checkbox"]`,
      );
      const table = '[data-table-id="profiles"]';
      const captured = new Set(["dracula", "tokyo-night", "ayu-light"]);
      for (const theme of THEMES) {
        await applyThemeForContrastAudit(app, theme);
        const colors = await paintedColors(app, {
          header: [`${table} thead th`, en.profileTable.tagsHeader],
          selected: [
            `${table} tr[data-state="selected"] > td[data-table-column="name"]`,
          ],
          button: [`${table} [data-slot="table-view-trigger"]`],
          tag: [`${table} tbody [data-slot="badge"]`, "theme-tag"],
        });
        assert.ok(colors.page, `${theme.id} page colour`);
        assertQuietTint(colors.header, colors.page, 1.35, `${theme.id} header`);
        assertQuietTint(
          colors.selected,
          colors.page,
          1.6,
          `${theme.id} selected row`,
        );
        assertQuietTint(colors.button, colors.page, 1.35, `${theme.id} button`);
        assertQuietTint(colors.tag, colors.page, 1.4, `${theme.id} tag`);
        if (captured.has(theme.id)) await app.capture(`table-${theme.id}`);
      }

      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Theme profile");
      await app.clickSelector("#enable-password");
      await app.fillSelector("#profile-password", "theme password");
      for (const theme of THEMES) {
        await applyThemeForContrastAudit(app, theme);
        const colors = await paintedColors(app, {
          off: ["#ephemeral"],
          on: ["#enable-password"],
          name: ['[data-slot="profile-name-field"]'],
          password: ["#profile-password"],
        });
        assertQuietTint(colors.off, colors.page, 1.35, `${theme.id} option`);
        assertQuietTint(
          colors.on,
          colors.page,
          1.6,
          `${theme.id} chosen option`,
        );
        assertQuietTint(colors.name, colors.page, 1.35, `${theme.id} name`);
        assertQuietTint(
          colors.password,
          colors.page,
          1.35,
          `${theme.id} password field`,
        );
        if (captured.has(theme.id)) await app.capture(`creation-${theme.id}`);
      }
    },
    { seedDownloadedBrowser: true },
  );
});
test("the integrations page ships only the Local API tab and never names remote control for a regular desktop", async () => {
  await withApp("ui-integrations", async (app) => {
    const modifier =
      process.platform === "darwin" ? { meta: true } : { ctrl: true };
    await app.clickSelector('[aria-label="Integrations"]');
    await app.waitForText(en.integrations.tabApi);

    // Local MCP is gone, and remote control is an Enterprise feature that a
    // desktop without the entitlement is never told about. This session is
    // signed out, so a second tab here means the gate opened for everyone.
    const tabs = async () =>
      app.execute(
        `return [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent.trim());`,
      );
    assert.deepEqual(await tabs(), [en.integrations.tabApi]);
    // The whole document, not just the painted text: a hidden trigger or an
    // unmounted-looking panel is still a mention.
    const html = await app.html();
    for (const phrase of [
      en.integrations.tabRemote,
      en.integrations.remote.enableLabel,
      en.integrations.remote.signInRequired,
      en.integrations.remote.endpointLabel,
    ]) {
      assert.ok(
        !html.includes(phrase),
        `remote control must stay out of sight: ${JSON.stringify(phrase)}`,
      );
    }
    assert.equal(
      (await app.invoke("get_mcp_remote_status")).enabled,
      false,
      "opening the page must not open the bridge",
    );

    // Mod+I flips to Remote MCP only for an entitled account, so here it
    // never lands on a tab that is not offered.
    const activeTab = async () =>
      app.execute(
        `return document.querySelector('[role="tab"][data-state="active"]')?.textContent.trim() ?? null;`,
      );
    assert.equal(await activeTab(), en.integrations.tabApi);
    await app.pressShortcut({ key: "i", ...modifier });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await activeTab(), en.integrations.tabApi);
    assert.deepEqual(await tabs(), [en.integrations.tabApi]);

    await dismissSurface(app);
  });
});

test("MCP clients on this computer come first, and toolsets go to the connected clients", async () => {
  await withApp("ui-mcp-clients", async (app) => {
    await stubCommand(app, "get_remote_control_entitlement", true);
    await stubCommand(app, "get_mcp_remote_status", {
      enabled: true,
      connected: true,
      instanceId: "ui-mcp-clients",
      lastError: null,
    });
    await stubCommand(app, "get_mcp_remote_credential", {
      present: true,
      tokenPrefix: "dmk_ui",
    });
    const remoteKey = "dmk_ui_0123456789abcdefghijklmnopqrstuvwxyz";
    await stubCommand(app, "get_app_settings", {
      ...(await app.invoke("get_app_settings")),
      mcp_remote_key: remoteKey,
    });
    const agent = (id, display_name, connected, detected) => ({
      id,
      display_name,
      category: "cli",
      connected,
      current: connected,
      detected,
      token_env: null,
    });
    await stubCommand(app, "list_mcp_agents", [
      agent("cursor", "Cursor", false, false),
      agent("codex", "Codex", false, true),
      agent("claude-code", "Claude Code", true, true),
      agent("pi", "Pi", false, true),
      agent("zed", "Zed", false, false),
    ]);
    await stubCommand(app, "add_mcp_to_agent", null);
    await stubCommand(app, "set_mcp_toolsets", []);
    await stubCommand(app, "forget_mcp_remote_credential", null);
    const calls = (command) =>
      app.execute(
        "return (window.__donutStubbedCalls ?? []).filter((c) => c.command === arguments[0]).map((c) => c.payload);",
        [command],
      );
    const shown = () =>
      app.execute(
        `return [...document.querySelectorAll('[data-slot="mcp-client"]')].map((node) => node.dataset.agentId);`,
      );

    await app.clickSelector('[aria-label="Integrations"]');
    await app.clickText(en.integrations.tabRemote, { roles: ["tab"] });
    await app.waitForText(en.integrations.mcp.onThisComputer);
    assert.deepEqual(
      await shown(),
      ["claude-code", "codex", "pi"],
      "connected first, then the other apps found here; the rest wait",
    );
    await app.clickSelector('[data-slot="mcp-show-more"]');
    await app.waitFor(async () => (await shown()).length === 5, {
      description: "every client after Show more",
    });

    await app.clickSelector('[data-slot="mcp-add-all"]');
    await app.waitFor(
      async () => (await calls("add_mcp_to_agent")).length === 2,
      {
        description: "one add per suggested client",
      },
    );
    assert.deepEqual(
      (await calls("add_mcp_to_agent")).map((payload) => payload.agentId),
      ["codex", "pi"],
    );

    await app.clickSelector('[data-slot="mcp-toolsets"]');
    await app.waitForText(en.integrations.mcp.toolsets.title);
    await app.capture("mcp-toolsets");
    await app.clickSelector('[data-toolset="cookies"]');
    await app.waitFor(
      async () => (await calls("set_mcp_toolsets")).length === 1,
      {
        description: "the toolset choice saved",
      },
    );
    assert.deepEqual((await calls("set_mcp_toolsets"))[0].toolsets, [
      "organize",
      "network",
      "traffic",
      "fingerprint",
      "extensions",
      "sync",
      "remote",
      "recipes",
    ]);
    await dismissSurface(app);

    // The page shows the credential by its prefix only; every copy carries
    // the whole key, so a pasted command runs as is.
    await app.execute(
      `window.__copied = [];
       navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };`,
    );
    const copied = () => app.execute("return window.__copied;");
    const page = await app.bodyText();
    assert.ok(!page.includes(remoteKey), "the full key is never on screen");
    assert.ok(page.includes("dmk_ui…"), page);
    const remoteTarget = { baseUrl: REMOTE_MCP_URL, token: remoteKey };
    await app.clickSelector(
      '[data-slot="code-snippet"]:has([data-testid="integrations-remote-example"]) button',
    );
    await app.waitFor(async () => (await copied()).length === 1, {
      description: "the remote quick start was copied",
    });
    assert.equal(
      (await copied())[0],
      oneLine(curlSnippet(REMOTE_MCP_EXAMPLES[0].request, remoteTarget)),
    );
    await app.clickSelector('[data-slot="mcp-credential"] button');
    await app.waitFor(async () => (await copied()).length === 2, {
      description: "the credential was copied",
    });
    assert.equal((await copied())[1], remoteKey);
    await app.clickText(en.integrations.examples.open);
    await app.waitForText(en.integrations.examples.remoteTitle);
    const examples =
      (await dialogText(app, en.integrations.examples.remoteTitle)) ?? "";
    assert.ok(!examples.includes(remoteKey), "the full key is never on screen");
    assert.ok(examples.includes(en.integrations.examples.credentialIncluded));
    await app.clickSelector('[data-testid="code-example-listTools"]');
    await app.clickSelector(
      '[data-testid="code-examples-dialog"] [data-slot="code-snippet"] button',
    );
    await app.waitFor(async () => (await copied()).length === 3, {
      description: "the List tools example was copied",
    });
    assert.equal(
      (await copied())[2],
      curlSnippet(REMOTE_MCP_EXAMPLES[0].request, remoteTarget),
    );
    await dismissSurface(app);

    // Forgetting the credential asks first, then revokes and removes it.
    await app.clickSelector('[data-slot="mcp-credential-forget"]');
    await app.waitForText(en.integrations.remote.credentialForgetTitle);
    await app.clickTextIn(
      '[role="dialog"]',
      en.integrations.remote.credentialForget,
      { roles: ["button"] },
    );
    await app.waitFor(
      async () => (await calls("forget_mcp_remote_credential")).length === 1,
      { description: "the confirmed forget reached the backend" },
    );
    await app.waitForText(en.integrations.remote.credentialForgotten);
    await dismissSurface(app);
  });
});

test("a rotated credential reaches the connected clients, and Retry never mints again", async () => {
  await withApp("ui-mcp-rotation", async (app) => {
    await stubCommand(app, "get_remote_control_entitlement", true);
    await stubCommand(app, "get_mcp_remote_status", {
      enabled: true,
      connected: true,
      instanceId: "ui-mcp-rotation",
      lastError: null,
    });
    await stubCommand(app, "get_mcp_remote_credential", {
      present: true,
      tokenPrefix: "dmk_ui",
    });
    const remoteKey = "dmk_ui_0123456789abcdefghijklmnopqrstuvwxyz";
    await stubCommand(app, "get_app_settings", {
      ...(await app.invoke("get_app_settings")),
      mcp_remote_key: remoteKey,
    });
    const agent = (id, display_name, current) => ({
      id,
      display_name,
      category: "cli",
      connected: true,
      current,
      detected: true,
      token_env: id === "fx" ? "DONUT_MCP_TOKEN" : null,
    });
    await stubCommand(app, "list_mcp_agents", [
      agent("claude-code", "Claude Code", true),
      agent("cursor", "Cursor", false),
      agent("fx", "fx", true),
    ]);
    await stubCommand(app, "rotate_mcp_remote_credential", {
      token_prefix: "dmk_ui",
      failed_clients: ["cursor"],
    });
    await stubCommand(app, "refresh_mcp_agents", []);
    await stubCommand(app, "add_mcp_to_agent", null);
    const calls = (command) =>
      app.execute(
        "return (window.__donutStubbedCalls ?? []).filter((c) => c.command === arguments[0]).map((c) => c.payload);",
        [command],
      );

    await app.clickSelector('[aria-label="Integrations"]');
    await app.clickText(en.integrations.tabRemote, { roles: ["tab"] });
    await app.waitForText(en.integrations.mcp.onThisComputer);

    // Rotating says to restart the open clients. A client it missed is
    // retried with the stored key, never with a second mint, which would
    // revoke the key the other clients just got.
    await app.clickText(en.integrations.remote.credentialRotate);
    await app.waitForText(en.integrations.remote.credentialRestartClients);
    await app.waitForText(
      en.integrations.remote.credentialClientsFailed.replace(
        "{{clients}}",
        "Cursor",
      ),
    );
    await app.clickTextIn("[data-sonner-toast]", en.common.buttons.retry, {
      roles: ["button"],
    });
    await app.waitFor(
      async () => (await calls("refresh_mcp_agents")).length === 1,
      { description: "Retry wrote the stored key again" },
    );
    assert.equal(
      (await calls("rotate_mcp_remote_credential")).length,
      1,
      "Retry must not mint again",
    );
    await app.waitForText(en.integrations.remote.credentialClientsUpdated);

    // fx reads the key from the shell, so it is told to export the new one;
    // the line on screen shows only the prefix.
    await app.waitForText(en.integrations.remote.fxReexport);
    const fx = await app.execute(
      `return document.querySelector('[data-slot="mcp-fx-reexport"]')?.innerText ?? "";`,
    );
    assert.ok(fx.includes("export DONUT_MCP_TOKEN=dmk_ui…"), fx);
    assert.ok(!fx.includes(remoteKey), "the full key is never on screen");

    // Only the client that holds an older key offers Update, and Update
    // writes the stored key into that client alone.
    assert.equal(
      await app.execute(
        `return document.querySelectorAll('[data-slot="mcp-client-update"]').length;`,
      ),
      1,
    );
    await app.clickSelector(
      '[data-agent-id="cursor"] [data-slot="mcp-client-update"]',
    );
    await app.waitFor(
      async () => (await calls("add_mcp_to_agent")).length === 1,
      { description: "Update reached the backend" },
    );
    assert.equal((await calls("add_mcp_to_agent"))[0].agentId, "cursor");
    await app.waitForText(
      en.integrations.mcp.updatedClient.replace("{{name}}", "Cursor"),
    );
    await dismissSurface(app);
  });
});

test("the local API page shows a one-line example and opens runnable examples in a dialog", async () => {
  await withApp("ui-integrations-examples", async (app) => {
    const settings = await app.invoke("get_app_settings");
    const saved = await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        api_enabled: true,
        api_port: 0,
        api_token: null,
      },
    });
    const token = saved.api_token;
    assert.ok(token?.length >= 32);
    const port = await app.invoke("start_api_server", { port: 0 });
    const baseUrl = `http://127.0.0.1:${port}`;

    await app.clickSelector('[aria-label="Integrations"]');
    // The section label is set in capitals, so innerText reads it that way.
    await app.waitForText(en.integrations.apiExampleRequest.toUpperCase());
    await app.execute(
      `window.__copied = [];
       navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };`,
    );
    const copied = () => app.execute("return window.__copied;");

    // The page shows only the ends of the token, and the copy carries all of
    // it, so a pasted command runs as is.
    const quickStart = '[data-testid="integrations-api-example"]';
    const shown = await app.execute(
      "return document.querySelector(arguments[0]).innerText;",
      [quickStart],
    );
    assert.ok(!shown.includes(token), "the full token is never on screen");
    assert.ok(shown.includes(maskToken(token)));
    assert.ok(shown.includes(`${baseUrl}/v1/profiles`));
    await app.clickSelector(
      `[data-slot="code-snippet"]:has(${quickStart}) button`,
    );
    await app.waitFor(async () => (await copied()).length === 1, {
      description: "the quick start was copied",
    });
    assert.equal(
      (await copied())[0],
      oneLine(curlSnippet(LOCAL_API_EXAMPLES[0].request, { baseUrl, token })),
    );

    // The connection test is one row until it runs: no stations and no
    // verdicts before there is a result.
    const diagnostics = '[data-slot="integration-diagnostics"]';
    const probe = () =>
      app.execute(
        `const panel = document.querySelector(arguments[0]);
         return {
           height: panel.getBoundingClientRect().height,
           flow: panel.querySelector('[data-slot="operation-flow"]')?.dataset.state ?? null,
           problem: panel.querySelector('[data-slot="integration-diagnostics-problem"]')?.innerText ?? null,
           text: panel.innerText,
         };`,
        [diagnostics],
      );
    const idle = await probe();
    assert.equal(idle.flow, null);
    assert.ok(!idle.text.includes(en.appFeedback.notVerified), idle.text);
    assert.ok(idle.height < 110, `idle connection test is ${idle.height}px`);
    await app.clickTextIn(diagnostics, en.appFeedback.testConnection, {
      roles: ["button"],
    });
    await app.waitFor(async () => (await probe()).flow === "done", {
      description: "the running API accepting the saved token",
    });
    const passed = await probe();
    assert.equal(passed.problem, null);
    assert.ok(passed.text.includes("HTTP 200"), passed.text);
    assert.ok(
      passed.height < 170,
      `tested connection test is ${passed.height}px`,
    );
    await app.capture("integrations-local-api");

    // A refusal names the station and the reason, and stays.
    await stubCommand(app, "check_integration_connection", {
      configured: true,
      reachable: true,
      authorized: false,
      http_status: 401,
      checked_at: Math.floor(Date.now() / 1000),
    });
    await app.clickTextIn(diagnostics, en.appFeedback.testConnection, {
      roles: ["button"],
    });
    await app.waitFor(async () => (await probe()).flow === "failed", {
      description: "the refused credential reported",
    });
    const refused = await probe();
    assert.equal(refused.problem, en.appFeedback.probeRefused);
    assert.ok(refused.text.includes("HTTP 401"), refused.text);
    assert.equal(
      await app.execute(
        `return document.querySelector(arguments[0] + ' [data-slot="operation-marker"]')?.dataset.nodeState ?? null;`,
        [diagnostics],
      ),
      "failed",
    );
    await app.capture("integrations-local-api-refused");

    await app.clickText(en.integrations.examples.open);
    await app.waitForText(en.integrations.examples.apiTitle);
    for (const example of LOCAL_API_EXAMPLES) {
      await app.clickSelector(`[data-testid="code-example-${example.id}"]`);
      await app.waitFor(
        async () =>
          (
            (await dialogText(app, en.integrations.examples.apiTitle)) ?? ""
          ).includes(en.integrations.examples.items[example.id].description),
        { description: `${example.id} example` },
      );
    }

    // The JavaScript the dialog hands over is real code against the real
    // server: run the copy and read the profiles it prints.
    await app.clickSelector('[data-testid="code-example-listProfiles"]');
    await app.clickText(en.integrations.examples.languages.javascript, {
      roles: ["tab"],
    });
    await app.clickSelector(
      '[data-testid="code-examples-dialog"] [data-slot="code-snippet"] button',
    );
    await app.waitFor(async () => (await copied()).length === 2, {
      description: "the JavaScript example was copied",
    });
    const javascript = (await copied())[1];
    assert.equal(
      javascript,
      javascriptSnippet(LOCAL_API_EXAMPLES[0].request, { baseUrl, token }),
    );
    const printed = [];
    await new (async () => {}).constructor("fetch", "console", javascript)(
      fetch,
      { log: (value) => printed.push(value) },
    );
    assert.equal(printed.length, 1);
    assert.ok(Array.isArray(printed[0].profiles), JSON.stringify(printed[0]));

    // "Try it" sends the listing to the running server with the saved token
    // and shows the answer in the dialog.
    await app.clickSelector('[data-slot="code-example-try"]');
    await app.waitFor(
      () =>
        app.execute(
          `const panel = document.querySelector('[data-slot="code-example-live-response"]');
           return panel?.dataset.status === "200" && panel.innerText.includes('"profiles"');`,
        ),
      { description: "the live answer of the local API" },
    );

    // The language is the reader's choice and stays as they move on.
    await app.clickSelector('[data-testid="code-example-createProxy"]');
    await app.waitFor(
      async () =>
        (
          (await dialogText(app, en.integrations.examples.apiTitle)) ?? ""
        ).includes("JSON.stringify({"),
      { description: "JavaScript stays selected" },
    );
    await app.capture("integrations-local-api-examples");
    await dismissSurface(app);
    await dismissSurface(app);

    await app.clickSelector(`[aria-label="${en.rail.account}"]`);
    await app.waitForText(en.account.signedOutDescription);
    await app.capture("account-signed-out");
    await dismissSurface(app);
  });
});

test("all primary navigation buttons and sub-page tabs render and remain interactive", async () => {
  await withApp("ui-navigation", async (app) => {
    const surfaces = [
      ["Settings", /General|Appearance|Sync/i],
      ["Network", /Proxies|VPNs|DNS/i],
      ["Extensions", /Extensions|Groups/i],
      ["Integrations", /API|MCP/i],
      ["Account", /Account|Sign in/i],
    ];
    for (const [label, expected] of surfaces) {
      await app.clickSelector(`[aria-label="${label}"]`);
      await app.waitFor(async () => expected.test(await app.bodyText()), {
        description: `${label} surface`,
      });
      assert.match(await app.bodyText(), expected);
      await dismissSurface(app);
    }

    await app.clickSelector('[aria-label="Groups"]');
    await app.waitForText(en.groupManagement.newGroup);
    await dismissSurface(app);

    await app.clickSelector('[aria-label="More"]');
    await app.waitFor(
      () =>
        app.execute(`return Boolean(document.querySelector("[role='menu']"));`),
      { description: "More menu" },
    );
    await dismissSurface(app);

    await app.clickSelector('[aria-label="Profiles"]');
    await app.clickText("New");
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector("[role='dialog']"));`,
        ),
      { description: "new profile dialog" },
    );
    assert.match(await app.bodyText(), /profile/i);
    await dismissSurface(app);
  });
});

test("every custom theme keeps tabs, counts, group pills, and rail states readable", async () => {
  await withApp("ui-theme-contrast", async (app) => {
    await app.clickSelector('[aria-label="Extensions"]');
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelectorAll('[data-slot="animated-tabs-trigger"]').length === 2;`,
        ),
      { description: "Extension tabs" },
    );

    for (const theme of THEMES) {
      await applyThemeForContrastAudit(app, theme);
      const snapshot = await animatedTabContrastSnapshot(app);
      assert.equal(snapshot.mode, theme.mode, `${theme.id} appearance mode`);
      assertColorEquals(
        snapshot.activeBackground,
        snapshot.accent,
        `${theme.id} active tab background`,
      );
      for (const [label, color] of [
        ["active tab title", snapshot.activeTitle],
        ["active tab count", snapshot.activeCount],
      ]) {
        assertColorEquals(
          color,
          snapshot.accentForeground,
          `${theme.id} ${label} token`,
        );
        assertContrast(
          color,
          snapshot.activeBackground,
          4.5,
          `${theme.id} ${label}`,
        );
      }
      for (const [label, color] of [
        ["inactive tab title", snapshot.inactiveTitle],
        ["inactive tab count", snapshot.inactiveCount],
      ]) {
        assertColorEquals(
          color,
          snapshot.mutedForeground,
          `${theme.id} ${label} token`,
        );
        assertContrast(color, snapshot.background, 4.5, `${theme.id} ${label}`);
      }

      await app.clickSelector(
        '[data-slot="animated-tabs-trigger"][data-state="inactive"]',
      );
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector(
              '[data-slot="animated-tabs-trigger"][data-state="active"] [data-slot="animated-tabs-indicator"]'
            ));`,
          ),
        { description: `${theme.id} tab indicator after switching` },
      );
    }

    await app.clickSelector('[aria-label="Groups"]');
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector('[data-summary="groups"] [data-slot="animated-tabs-indicator"]'));`,
        ),
      { description: "Profile groups summary tab" },
    );

    for (const theme of THEMES) {
      await applyThemeForContrastAudit(app, theme);
      const snapshot = await app.execute(`
        const rootStyle = getComputedStyle(document.documentElement);
        // The page title is the active tab of a one-tab list, as on the
        // other sub-pages: its fill is the tab indicator.
        const pill = document.querySelector('[data-summary="groups"]');
        const count = pill?.querySelector(
          '[data-slot="group-summary-count"]',
        );
        const title = pill?.querySelector('[data-slot="group-summary-title"]');
        const fill = pill?.querySelector(
          '[data-slot="animated-tabs-indicator"]',
        );
        const rail = document.querySelector('nav [aria-current="page"]');
        // The active item's fill is a translucent pill over the rail. Paint
        // both on a 1px canvas to read the colour under the icon.
        const railFill = (() => {
          if (!rail) return null;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          const layers = [
            rail.closest("nav"),
            rail.querySelector('[data-slot="rail-active-pill"]'),
          ];
          for (const node of layers) {
            if (!node) continue;
            context.fillStyle = getComputedStyle(node).backgroundColor;
            context.fillRect(0, 0, 1, 1);
          }
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          return "rgb(" + r + ", " + g + ", " + b + ")";
        })();
        return {
          pillBackground: fill ? getComputedStyle(fill).backgroundColor : null,
          pillTitle: title ? getComputedStyle(title).color : null,
          pillCount: count ? getComputedStyle(count).color : null,
          railBackground: railFill,
          railForeground: rail ? getComputedStyle(rail).color : null,
          accent: rootStyle.getPropertyValue("--accent").trim(),
          accentForeground: rootStyle
            .getPropertyValue("--accent-foreground")
            .trim(),
        };
      `);
      assertColorEquals(
        snapshot.pillBackground,
        snapshot.accent,
        `${theme.id} group pill background`,
      );
      for (const [label, color] of [
        ["group pill title", snapshot.pillTitle],
        ["group pill count", snapshot.pillCount],
      ]) {
        assertColorEquals(
          color,
          snapshot.accentForeground,
          `${theme.id} ${label} token`,
        );
        assertContrast(
          color,
          snapshot.pillBackground,
          4.5,
          `${theme.id} ${label}`,
        );
      }
      assertContrast(
        snapshot.railForeground,
        snapshot.railBackground,
        3,
        `${theme.id} selected rail icon`,
      );
    }
  });
});

test("Xray proxy form keeps the share link as one clear, validated input", async () => {
  await withApp("ui-vless-proxy-form", async (app) => {
    const uri =
      "vless://6d6e21a1-4829-4d2b-bc7f-1b25707b61e4@vpn.example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc&sid=0123456789abcdef&type=tcp#E2E";

    await app.clickSelector('[aria-label="Network"]');
    await app.waitForText("New proxy");
    await app.clickSelector('[aria-label="New proxy"]');
    await app.waitForText("Add Proxy");
    await app.fillSelector("#proxy-name", "E2E VLESS");
    // chooseSelectOption matches the label exactly.
    await chooseSelectOption(app, "#proxy-type", "VLESS");

    assert.equal(
      await app.execute(
        `return document.querySelector("#proxy-vless-uri") instanceof HTMLTextAreaElement;`,
      ),
      true,
    );
    assert.equal(
      await app.execute(
        `return document.querySelector("#proxy-host") === null &&
          document.querySelector("#proxy-port") === null &&
          document.querySelector("#proxy-username") === null &&
          document.querySelector("#proxy-password") === null;`,
      ),
      true,
    );

    await app.fillSelector(
      "#proxy-vless-uri",
      "vless://6d6e21a1-4829-4d2b-bc7f-1b25707b61e4@vpn.example.com",
    );
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("#proxy-vless-uri")?.getAttribute("aria-invalid") === "true";`,
        ),
      { description: "invalid VLESS endpoint feedback" },
    );
    assert.equal(
      await app.execute(
        `return [...document.querySelectorAll("[role='dialog'] button")]
          .find((button) => button.textContent?.trim() === "Add Proxy")
          ?.disabled === true;`,
      ),
      true,
    );

    // A well-formed link for a setup Donut cannot use must say WHICH part is
    // unsupported, rather than implying the user mistyped it.
    await app.fillSelector(
      "#proxy-vless-uri",
      `${uri.replace("type=tcp", "type=kcp")}&seed=x`,
    );
    // The hint below the field also says "transport", so only the backend's
    // refusal, which marks the field invalid, counts here.
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("#proxy-vless-uri")?.getAttribute("aria-invalid") === "true" &&
            /uses a transport/i.test(
              document.querySelector("#proxy-vless-uri-help")?.textContent || ""
            );`,
        ),
      { description: "transport-specific unsupported message" },
    );

    // The link names its protocol, and the backend stores the proxy under it,
    // so the form follows the link before anything is saved.
    await app.fillSelector(
      "#proxy-vless-uri",
      "trojan://pw@tj.example.com:443?sni=tj.example.com",
    );
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("#proxy-type")?.textContent?.trim() === "Trojan";`,
        ),
      { description: "type follows a Trojan link" },
    );

    await app.fillSelector("#proxy-vless-uri", uri);
    // The field is not marked invalid while the backend is still reading the
    // link, so the enabled button is what proves it was accepted.
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("#proxy-vless-uri")?.getAttribute("aria-invalid") === "false" &&
            [...document.querySelectorAll("[role='dialog'] button")]
              .find((button) => button.textContent?.trim() === "Add Proxy")
              ?.disabled === false;`,
        ),
      { description: "valid VLESS endpoint feedback" },
    );
    await app.clickTextIn('[role="dialog"]', "Add Proxy", {
      roles: ["button"],
    });
    await app.waitForText("E2E VLESS");

    const proxy = (await app.invoke("get_stored_proxies")).find(
      (item) => item.name === "E2E VLESS",
    );
    assert.ok(proxy);
    assert.equal(proxy.proxy_settings.proxy_type, "vless");
    assert.equal(proxy.proxy_settings.host, "vpn.example.com");
    assert.equal(proxy.proxy_settings.port, 443);
    assert.equal(proxy.proxy_settings.username, null);
    assert.equal(proxy.proxy_settings.password, null);
    assert.match(proxy.proxy_settings.vless_uri, /^vless:\/\//);

    await app.invoke("delete_stored_proxy", { proxyId: proxy.id });
  });
});

test("pasting a proxy string into the form fills every field", async () => {
  await withApp("ui-proxy-form-paste", async (app) => {
    // Dispatched rather than typed: the point is that the paste is spread
    // across the form instead of landing whole in the field it was dropped on,
    // and only a real ClipboardEvent carries the text the handler reads.
    const paste = (selector, text) =>
      app.execute(
        `const field = document.querySelector(arguments[0]);
         const data = new DataTransfer();
         data.setData("text/plain", arguments[1]);
         field.focus();
         return field.dispatchEvent(
           new ClipboardEvent("paste", {
             bubbles: true,
             cancelable: true,
             clipboardData: data,
           }),
         );`,
        [selector, text],
      );
    const fieldValues = () =>
      app.execute(
        `return ["#proxy-name", "#proxy-host", "#proxy-port", "#proxy-username", "#proxy-password"]
           .map((selector) => document.querySelector(selector)?.value ?? null);`,
      );

    await app.clickSelector('[aria-label="Network"]');
    await app.waitForText("New proxy");
    await app.clickSelector('[aria-label="New proxy"]');
    await app.waitForText("Add Proxy");

    await paste("#proxy-host", "socks5://carol:s3cret@1.2.3.4:1080");
    await app.waitFor(async () => (await fieldValues())[1] === "1.2.3.4", {
      description: "host filled from the pasted proxy",
    });
    assert.deepEqual(await fieldValues(), [
      "1.2.3.4:1080",
      "1.2.3.4",
      "1080",
      "carol",
      "s3cret",
    ]);
    assert.equal(
      await app.execute(
        `return document.querySelector("#proxy-type")?.textContent?.trim();`,
      ),
      "SOCKS5",
    );

    // No scheme in the line, so the type falls back to HTTP.
    await paste("#proxy-name", "5.6.7.8:8080:dave:hunter2");
    await app.waitFor(async () => (await fieldValues())[1] === "5.6.7.8", {
      description: "scheme-less proxy string parsed",
    });
    assert.deepEqual((await fieldValues()).slice(1), [
      "5.6.7.8",
      "8080",
      "dave",
      "hunter2",
    ]);
    assert.equal(
      await app.execute(
        `return document.querySelector("#proxy-type")?.textContent?.trim();`,
      ),
      "HTTP",
    );

    // A bare hostname is not a proxy string, so the form is left alone and the
    // browser's own paste stands.
    await paste("#proxy-host", "proxy.example.com");
    // Settle the parse round-trip, so "nothing changed" isn't just "nothing
    // has come back yet".
    await app.invoke("get_stored_proxies");
    assert.deepEqual((await fieldValues()).slice(1), [
      "5.6.7.8",
      "8080",
      "dave",
      "hunter2",
    ]);
  });
});

test("About exposes a searchable, responsive third-party license inventory", async () => {
  await withApp("ui-about-licenses", async (app) => {
    await app.clickSelector('[aria-label="More"]');
    await app.waitFor(
      () =>
        app.execute(`return Boolean(document.querySelector("[role='menu']"));`),
      { description: "More menu" },
    );
    await app.clickText("About Donut Browser", {
      exact: false,
      roles: ["menuitem"],
    });
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector("[role='dialog'] [data-slot='about-diagnostics']"));`,
        ),
      { description: "About diagnostics" },
    );

    const aboutText = await app.execute(
      `return document.querySelector("[role='dialog']")?.textContent ?? "";`,
    );
    assert.doesNotMatch(aboutText, /AGPL-3\.0|licensed under/i);

    await app.clickText("Licenses", { roles: ["button"] });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("[role='dialog'] [data-slot='dialog-title']")?.textContent === "Licenses";`,
        ),
      { description: "Licenses view" },
    );

    await app.session.command("POST", "/window/rect", {
      width: 640,
      height: 400,
    });
    const inventory = await app.execute(`
      const dialog = document.querySelector("[role='dialog']");
      const list = dialog?.querySelector(".scroll-fade");
      const search = dialog?.querySelector('input[type="search"]');
      const rows = [...(dialog?.querySelectorAll("li") ?? [])].map((row) =>
        [...row.children].map((child) => (child.textContent || "").trim())
      );
      const rect = dialog?.getBoundingClientRect();
      return {
        activeSearch: document.activeElement === search,
        rows,
        scrollable: Boolean(list && list.scrollHeight > list.clientHeight),
        bounds: rect
          ? {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
            }
          : null,
      };
    `);
    assert.equal(inventory.activeSearch, true);
    assert.equal(inventory.scrollable, true);
    assert.ok(inventory.bounds);
    assert.ok(inventory.bounds.left >= 0);
    assert.ok(inventory.bounds.top >= 0);
    assert.ok(inventory.bounds.right <= inventory.bounds.viewportWidth);
    assert.ok(inventory.bounds.bottom <= inventory.bounds.viewportHeight);
    assert.ok(
      inventory.rows.some(
        ([name, license]) => name === "Xray-core" && license === "MPL-2.0",
      ),
    );
    assert.ok(
      inventory.rows.some(
        ([name, license]) =>
          name === "Donut Browser" && license === "AGPL-3.0-only",
      ),
    );
    assert.ok(
      inventory.rows.some(
        ([name, license]) =>
          name === "tauri-plugin-opener" && license === "Apache-2.0 OR MIT",
      ),
    );
    assert.ok(inventory.rows.every((row) => row.length === 2));

    const search = await app.session.findCss('input[type="search"]');
    await app.session.sendKeys(search, "xray");
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelectorAll("[role='dialog'] li").length === 1;`,
        ),
      { description: "license search result" },
    );
    assert.match(
      await app.execute(
        `return document.querySelector("[role='dialog'] li")?.textContent ?? "";`,
      ),
      /Xray-core.*MPL-2\.0/s,
    );

    await app.clickSelector('button[aria-label="Back"]');
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector("[role='dialog'] [data-slot='dialog-title']")?.textContent === "Donut Browser";`,
        ),
      { description: "About view after returning from licenses" },
    );
    assert.equal(
      await app.execute(
        `return document.activeElement?.textContent?.trim() === "Licenses";`,
      ),
      true,
    );
  });
});

test("settings tabs, command palette filtering, and responsive layout survive resize", async () => {
  await withApp("ui-settings-responsive", async (app) => {
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    for (const tab of ["Appearance", "Sync", "Encryption"]) {
      const exists = await app.execute(
        `return [...document.querySelectorAll("[role='tab']")].some(
          (node) => (node.textContent || "").trim() === arguments[0]
        );`,
        [tab],
      );
      if (exists) {
        await app.clickText(tab, { roles: ["tab"] });
        await app.waitFor(
          () =>
            app.execute(
              `return [...document.querySelectorAll("[role='tab']")].some(
                (node) => (node.textContent || "").trim() === arguments[0] &&
                  node.getAttribute("data-state") === "active"
              );`,
              [tab],
            ),
          { description: `${tab} settings tab` },
        );
      }
    }
    await dismissSurface(app);

    const modifier =
      process.platform === "darwin" ? { meta: true } : { ctrl: true };
    await app.pressShortcut({ key: "k", ...modifier });
    await app.waitFor(
      () =>
        app.execute(`return Boolean(document.querySelector("[cmdk-input]"));`),
      { description: "command palette" },
    );
    const input = await app.session.findCss("[cmdk-input]");
    await app.session.sendKeys(input, "proxy vpn");
    assert.match(await app.bodyText(), /Network|Proxy|VPN/i);
    await dismissSurface(app);

    // The native driver owns the top-level window. Resize through the WebDriver
    // protocol and assert the app still has usable controls at the minimum size.
    await app.session.command("POST", "/window/rect", {
      width: 640,
      height: 400,
    });
    const viewport = await app.execute(
      "return { width: innerWidth, height: innerHeight };",
    );
    assert.ok(viewport.width >= 600);
    assert.ok(viewport.height >= 350);
    assert.equal(
      await app.execute(
        `return document.querySelector('[aria-label="Settings"]').getBoundingClientRect().width > 0;`,
      ),
      true,
    );
  });
});

test("the command palette finds synonyms, remembers recent commands, and opens nested pages", async () => {
  await withApp("ui-command-palette", async (app) => {
    const modifier =
      process.platform === "darwin" ? { meta: true } : { ctrl: true };
    const paletteOpen = () =>
      app.execute(`return Boolean(document.querySelector("[cmdk-input]"));`);
    const openPalette = async () => {
      await app.pressShortcut({ key: "k", ...modifier });
      await app.waitFor(paletteOpen, { description: "command palette" });
    };
    const hasSelector = (selector) =>
      app.execute(`return Boolean(document.querySelector(arguments[0]));`, [
        selector,
      ]);
    const placeholder = () =>
      app.execute(`return document.querySelector("[cmdk-input]").placeholder;`);
    const waitSelected = (value) =>
      app.waitFor(
        async () =>
          (await app.execute(
            `return document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute("data-value") ?? null;`,
          )) === value,
        { description: `selected ${value}` },
      );
    const chip = '[data-slot="command-page-chip"][data-page="group"]';

    await openPalette();
    // A synonym finds a command its label does not name.
    await app.fillSelector("[cmdk-input]", "new");
    await waitSelected("action:createProfile");
    // The matched part of a label is marked.
    await app.fillSelector("[cmdk-input]", "trash");
    await waitSelected("shortcut:goTrash");
    assert.equal(
      await app.execute(
        `return document.querySelector('[cmdk-item][data-value="shortcut:goTrash"] mark')?.textContent ?? "";`,
      ),
      "Trash",
    );
    // Enter runs it, closes the palette, and remembers it.
    await app.pressShortcut({ key: "\uE007" });
    await app.waitFor(() => hasSelector('[data-slot="trash-page"]'), {
      description: "trash page",
    });
    assert.equal(await paletteOpen(), false);
    assert.deepEqual(
      await app.execute(
        `return JSON.parse(localStorage.getItem("donut.commandPalette.recent"));`,
      ),
      ["shortcut:goTrash"],
    );

    // Recent commands come first, so Enter repeats the last one.
    await openPalette();
    await waitSelected("recent:shortcut:goTrash");

    // A page opens with a breadcrumb and its own search, and Backspace in
    // the empty search goes back to the entry it came from.
    await app.clickSelector('[cmdk-item][data-value="page:group"]');
    await app.waitFor(() => hasSelector(chip), { description: "group page" });
    assert.equal(
      await placeholder(),
      en.commandPalette.pages.group.placeholder,
    );
    await waitSelected("group:__all__");
    await app.pressShortcut({ key: "\uE003" });
    await app.waitFor(async () => !(await hasSelector(chip)), {
      description: "back to all commands",
    });
    assert.equal(await placeholder(), en.commandPalette.placeholder);
    await waitSelected("page:group");

    // Escape leaves a page first, then closes the palette.
    await app.pressShortcut({ key: "\uE007" });
    await app.waitFor(() => hasSelector(chip), { description: "group page" });
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(async () => !(await hasSelector(chip)), {
      description: "Escape leaves the page",
    });
    assert.equal(await paletteOpen(), true);

    // The palette shortcut closes the palette it opened.
    await app.pressShortcut({ key: "k", ...modifier });
    await app.waitFor(async () => !(await paletteOpen()), {
      description: "the palette shortcut closes the palette",
    });
  });
});

test("first-run onboarding stays recoverable, responsive, and platform-aware", async () => {
  await withApp(
    "ui-onboarding",
    async (app) => {
      await app.waitForText("Welcome to Donut Browser");
      assert.equal(await app.invoke("get_onboarding_completed"), false);

      await app.session.command("POST", "/window/rect", {
        width: 640,
        height: 400,
      });
      const layout = await app.execute(`
        const dialog = document.querySelector("[role='dialog']");
        const progress = dialog?.querySelector("[role='progressbar']");
        if (!dialog || !progress) return null;
        const rect = dialog.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          progressNow: progress.getAttribute("aria-valuenow"),
        };
      `);
      assert.ok(layout);
      assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth);
      assert.ok(layout.top >= 0 && layout.bottom <= layout.viewportHeight);
      assert.equal(layout.progressNow, "1");

      await app.clickText("Next", { roles: ["button"] });
      await app.waitForText(en.isolationDemo.title);
      await app.clickText("Next", { roles: ["button"] });
      await app.waitForText("Licensing");
      // Back returns to the step before, and the dots follow.
      await app.clickSelector('[data-slot="welcome-back"]');
      await app.waitForText(en.isolationDemo.title);
      assert.equal(
        await app.execute(
          `return document.querySelector("[role='dialog'] [data-slot='step-dots']")?.getAttribute("aria-valuenow");`,
        ),
        "2",
      );
      await app.clickText("Next", { roles: ["button"] });
      await app.waitForText("Licensing");
      await app.clickText("I understand", { roles: ["button"] });

      await app.waitFor(
        async () =>
          /Allow microphone & camera|Setting things up|Setup failed/.test(
            await app.bodyText(),
          ),
        { description: "platform-appropriate onboarding step" },
      );
      const body = await app.bodyText();
      if (process.platform !== "darwin") {
        assert.doesNotMatch(body, /Allow microphone & camera/);
        assert.match(body, /Setting things up|Setup failed/);
      }

      // Setup and the optional product tour are still unfinished, so a crash
      // or restart must be able to resume onboarding.
      assert.equal(await app.invoke("get_onboarding_completed"), false);
    },
    { onboardingCompleted: false },
  );
});

/** The tour's coach mark: its step and anchor, once it is placed and shown. */
async function tourState(app) {
  return app.execute(`
    const card = document.querySelector('[data-slot="onboarding-tour"]');
    if (!card || card.dataset.state !== "shown") return null;
    if (getComputedStyle(card.parentElement).visibility !== "visible") return null;
    return {
      step: card.dataset.step,
      anchor: card.dataset.anchor,
      spotlight: Boolean(document.querySelector('[data-slot="coach-mark-spotlight"]')),
    };
  `);
}

test("a new install walks from the welcome into a tour on the real controls", async () => {
  await withApp(
    "ui-onboarding-tour",
    async (app) => {
      await app.waitForText(en.welcome.title);
      await app.clickText(en.welcome.next, { roles: ["button"] });
      await app.waitForText(en.isolationDemo.title);
      await app.clickText(en.welcome.next, { roles: ["button"] });
      await app.waitForText(en.welcome.license.title);
      await app.clickText(en.welcome.license.agree, { roles: ["button"] });
      // macOS asks for the microphone and camera unless they are granted.
      const next = await app.waitFor(
        async () => {
          const body = await app.bodyText();
          if (body.includes(en.welcome.permissions.title)) return "permissions";
          if (body.includes(en.welcome.ready.title)) return "setup";
          return null;
        },
        { description: "the step after licensing" },
      );
      if (next === "permissions") {
        await app.clickText(en.welcome.permissions.skip, { roles: ["button"] });
      }
      // The browser is registered already, so setup is ready at once.
      await app.waitForText(en.welcome.ready.cta);
      await app.clickText(en.welcome.ready.cta, { roles: ["button"] });

      // Step one dims the page around the New button and waits for a profile.
      const first = await app.waitFor(
        async () => {
          const state = await tourState(app);
          return state?.step === "0" ? state : null;
        },
        { description: "the tour on the New button" },
      );
      assert.equal(first.anchor, "new-profile");
      assert.ok(first.spotlight, "the page is dimmed around the button");
      assert.equal(
        await app.execute(
          `return document.elementFromPoint(...(() => { const r = document.querySelector('[data-tip-anchor="new-profile"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })())?.closest('[data-tip-anchor="new-profile"]') !== null;`,
        ),
        true,
        "the spotlit button still takes the click",
      );
      assert.equal(await app.invoke("get_onboarding_completed"), false);
      await app.capture("onboarding-tour-create");

      // A profile moves the tour on to that profile's DNS blocking.
      await createUiProfile(app, "Tour Profile");
      const second = await app.waitFor(
        async () => {
          const state = await tourState(app);
          return state?.step === "1" && state.anchor !== "none" ? state : null;
        },
        { description: "the tour on the DNS control" },
      );
      assert.ok(
        ["row-dns", "column-dns"].includes(second.anchor),
        `the DNS step points at DNS blocking, not ${second.anchor}`,
      );
      await app.capture("onboarding-tour-dns");

      await app.clickSelector('[data-slot="onboarding-tour-finish"]');
      await app.waitForText(en.onboarding.thankYou.title);
      await app.waitFor(() => app.invoke("get_onboarding_completed"), {
        description: "onboarding completed by the finished tour",
      });
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('[data-slot="onboarding-tour"]');`,
          ),
        { description: "the tour gone after its exit" },
      );
    },
    { onboardingCompleted: false, seedDownloadedBrowser: true },
  );
});

test("Escape skips the tour and still completes onboarding", async () => {
  await withApp(
    "ui-onboarding-tour-skip",
    async (app) => {
      await app.waitForText(en.welcome.title);
      await app.clickText(en.welcome.skip, { roles: ["button"] });
      await app.waitForText(en.welcome.ready.cta);
      await app.clickText(en.welcome.ready.cta, { roles: ["button"] });
      await app.waitFor(async () => (await tourState(app))?.step === "0", {
        description: "the tour",
      });
      await app.pressShortcut({ key: "Escape" });
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('[data-slot="onboarding-tour"]');`,
          ),
        { description: "the tour gone" },
      );
      await app.waitFor(() => app.invoke("get_onboarding_completed"), {
        description: "a skipped tour completes onboarding",
      });
      assert.equal(
        await app.visibleTextIncludes(en.onboarding.thankYou.title),
        false,
        "only a finished tour is celebrated",
      );
    },
    { onboardingCompleted: false, seedDownloadedBrowser: true },
  );
});

test("interface sounds, their pack, volume and kinds stay as saved", async () => {
  await withApp("ui-sounds-setting", async (app) => {
    const sounds = async () => (await app.invoke("get_app_settings")).ui_sounds;
    assert.equal(await sounds(), false, "the harness keeps the suite silent");
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText(en.settings.sounds.enabledDescription);
    const toggle = `[role="switch"][aria-label="${en.settings.sounds.enabled}"]`;
    const pack = '[data-slot="settings-sound-pack-option"][data-value="retro"]';
    assert.equal(
      await app.execute(
        `return Boolean(document.querySelector(arguments[0]));`,
        [pack],
      ),
      false,
      "the sound options stay hidden while sounds are off",
    );
    await app.clickSelector(toggle);
    await app.clickSelector(pack);
    await app.clickSelector(
      `[role="switch"][aria-label="${en.settings.sounds.categories.events.label}"]`,
    );
    await app.execute(
      `document.querySelector('[data-slot="settings-sound-volume"] [role="slider"]').focus();`,
    );
    await app.pressShortcut({ key: "\uE012" });
    await saveSettings(app);
    const saved = await app.invoke("get_app_settings");
    assert.equal(saved.ui_sounds, true);
    assert.equal(saved.ui_sound_pack, "retro");
    assert.equal(saved.ui_sound_events, false);
    assert.equal(saved.ui_sound_volume, 55);
    await app.clickSelector(toggle);
    await saveSettings(app);
    assert.equal(await sounds(), false);
    await app.restart();
    const restarted = await app.invoke("get_app_settings");
    assert.equal(restarted.ui_sounds, false, "the choice survives a restart");
    assert.equal(restarted.ui_sound_pack, "retro");
  });
});

test("system and bulk launch settings stay as saved", async () => {
  await withApp("ui-system-launch-settings", async (app) => {
    const before = await app.invoke("get_app_settings");
    assert.equal(before.launch_at_login, false);
    assert.equal(before.reopen_running_profiles, false);
    assert.equal(before.system_notifications, true);
    assert.equal(before.bulk_launch_delay_ms, 800);
    assert.equal(before.bulk_launch_concurrency, 3);
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText(en.settings.system.launchAtLoginDescription);
    await app.clickSelector("#settings-launch-at-login");
    await app.clickSelector("#settings-reopen-running");
    await app.clickSelector("#settings-system-notifications");
    // Each slider steps through its stops: 800 ms -> 1 s, 3 -> 4 at once.
    for (const slot of [
      "settings-bulk-launch-delay",
      "settings-bulk-launch-concurrency",
    ]) {
      await app.execute(
        `document.querySelector('[data-slot="' + arguments[0] + '"] [role="slider"]').focus();`,
        [slot],
      );
      await app.pressShortcut({ key: "\uE014" });
    }
    await saveSettings(app);
    const saved = await app.invoke("get_app_settings");
    assert.equal(saved.launch_at_login, true);
    assert.equal(saved.reopen_running_profiles, true);
    assert.equal(saved.system_notifications, false);
    assert.equal(saved.bulk_launch_delay_ms, 1000);
    assert.equal(saved.bulk_launch_concurrency, 4);
  });
});

test("predefined theme remains rendered across navigation and restart", async () => {
  await withApp("ui-theme-predefined", async (app) => {
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    await chooseThemeCard(app, "settings-theme-option", "light");
    await saveSettings(app);

    const persisted = await app.invoke("get_app_settings");
    assert.equal(persisted.theme, "light");
    const selected = await waitForTheme(
      app,
      (snapshot) =>
        snapshot.mode === "light" &&
        Object.values(snapshot.inline).every((value) => value === ""),
      "predefined light theme to render without custom variables",
    );
    assert.notEqual(selected.bodyBackground, "");
    assert.notEqual(selected.bodyForeground, "");
    await assertThemeAcrossNavigation(app, selected);

    await app.restart();
    assert.equal((await app.invoke("get_app_settings")).theme, "light");
    await app.waitFor(
      async () =>
        JSON.stringify(await themeSnapshot(app)) === JSON.stringify(selected),
      { description: "predefined light theme after restart" },
    );
  });
});

test("preset and manually customized themes survive navigation and restart", async () => {
  await withApp("ui-theme-custom", async (app) => {
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    await chooseThemeCard(app, "settings-theme-option", "custom");
    await chooseThemeCard(app, "settings-theme-preset", "dracula");
    await saveSettings(app);

    const presetSettings = await app.invoke("get_app_settings");
    assert.equal(presetSettings.theme, "custom");
    assert.deepEqual(presetSettings.custom_theme, DRACULA_THEME);
    const preset = await waitForTheme(
      app,
      (snapshot) =>
        snapshot.mode === "dark" &&
        themeVariablesEqual(snapshot.inline, DRACULA_THEME) &&
        themeVariablesEqual(snapshot.resolved, DRACULA_THEME),
      "Dracula preset variables to render",
    );
    await assertThemeAcrossNavigation(app, preset);

    await app.restart();
    assert.deepEqual(
      (await app.invoke("get_app_settings")).custom_theme,
      DRACULA_THEME,
    );
    await app.waitFor(
      async () =>
        JSON.stringify(await themeSnapshot(app)) === JSON.stringify(preset),
      { description: "Dracula preset after restart" },
    );

    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    assert.equal(
      await checkedThemeCard(app, "settings-theme-option"),
      "custom",
    );
    assert.equal(
      await checkedThemeCard(app, "settings-theme-preset"),
      "dracula",
    );
    await dragBackgroundColorPicker(app);
    await saveSettings(app);

    const customizedSettings = await app.invoke("get_app_settings");
    assert.equal(customizedSettings.theme, "custom");
    assert.notEqual(
      customizedSettings.custom_theme["--background"].toLowerCase(),
      DRACULA_THEME["--background"],
    );
    assert.deepEqual(
      Object.keys(customizedSettings.custom_theme).sort(),
      [...THEME_VARIABLES].sort(),
    );
    const customized = await waitForTheme(
      app,
      (snapshot) =>
        snapshot.mode === "dark" &&
        themeVariablesEqual(snapshot.inline, customizedSettings.custom_theme) &&
        themeVariablesEqual(snapshot.resolved, customizedSettings.custom_theme),
      "manually customized variables to render",
    );
    assert.notEqual(customized.bodyBackground, preset.bodyBackground);
    await assertThemeAcrossNavigation(app, customized);

    await app.restart();
    assert.deepEqual(
      (await app.invoke("get_app_settings")).custom_theme,
      customizedSettings.custom_theme,
    );
    await app.waitFor(
      async () =>
        JSON.stringify(await themeSnapshot(app)) === JSON.stringify(customized),
      { description: "manually customized theme after restart" },
    );
  });
});

test("a light custom preset keeps light component behavior after restart", async () => {
  await withApp("ui-theme-custom-light", async (app) => {
    await app.clickSelector('[aria-label="Settings"]');
    await app.waitForText("Appearance");
    await chooseThemeCard(app, "settings-theme-option", "custom");
    await chooseThemeCard(app, "settings-theme-preset", "ayu-light");
    await saveSettings(app);

    const selected = await waitForTheme(
      app,
      (snapshot) =>
        snapshot.mode === "light" &&
        themeVariablesEqual(snapshot.inline, AYU_LIGHT_THEME) &&
        themeVariablesEqual(snapshot.resolved, AYU_LIGHT_THEME),
      "Ayu Light variables and light mode to render",
    );
    await assertThemeAcrossNavigation(app, selected);

    await app.restart();
    assert.deepEqual(
      (await app.invoke("get_app_settings")).custom_theme,
      AYU_LIGHT_THEME,
    );
    await app.waitFor(
      async () =>
        JSON.stringify(await themeSnapshot(app)) === JSON.stringify(selected),
      { description: "Ayu Light preset after restart" },
    );
  });
});

const EXTENSION_STRINGS = en.extensions;

/**
 * Answer the native directory picker from inside the webview.
 *
 * "Load unpacked" calls `open({ directory: true })` from
 * `@tauri-apps/plugin-dialog`, which puts an OS window on screen that no
 * WebDriver can reach. The call leaves the page as the `plugin:dialog|open` IPC
 * command, but Tauri locks its own entry points down: `invoke`, `ipc` and
 * `postMessage` are all installed with
 * `Object.defineProperty(window.__TAURI_INTERNALS__, name, { value })`, so they
 * are non-writable and cannot be wrapped. The seam underneath them is the
 * transport, which POSTs the command through `fetch` to
 * `ipc://localhost/<command>`. Answering that one request with the shape Tauri
 * expects (`Tauri-Response: ok` plus a JSON body) resolves the picker with a
 * folder and needs no test-only hook in the production component. Every other
 * command still reaches the real backend.
 */
async function stubFolderPicker(app, folder) {
  await app.execute(
    `const folder = arguments[0];
     if (!window.__donutOriginalFetch) {
       window.__donutOriginalFetch = window.fetch;
     }
     window.__donutFolderPickerCalls = [];
     window.fetch = function (input, init) {
       const url = String(
         typeof input === "string" ? input : (input && input.url) || "",
       );
       let command = "";
       try {
         command = decodeURIComponent(url.split("/").pop() || "");
       } catch (_error) {
         command = "";
       }
       if (command === "plugin:dialog|open") {
         let payload = null;
         try {
           payload = JSON.parse((init && init.body) || "null");
         } catch (_error) {
           payload = null;
         }
         window.__donutFolderPickerCalls.push(payload);
         return Promise.resolve(
           new Response(JSON.stringify(folder), {
             status: 200,
             headers: {
               "content-type": "application/json",
               "Tauri-Response": "ok",
             },
           }),
         );
       }
       return window.__donutOriginalFetch.apply(window, arguments);
     };
     return true;`,
    [folder],
  );
}

/** Restores the real transport and returns what the picker was asked for. */
async function restoreFolderPicker(app) {
  return app.execute(
    `const calls = window.__donutFolderPickerCalls ?? [];
     if (window.__donutOriginalFetch) {
       window.fetch = window.__donutOriginalFetch;
       delete window.__donutOriginalFetch;
     }
     delete window.__donutFolderPickerCalls;
     return calls;`,
  );
}

async function openExtensionsPage(app) {
  await app.clickSelector('[aria-label="Extensions"]');
  await app.waitFor(
    () =>
      app.execute(`return Boolean(document.querySelector(arguments[0]));`, [
        `[aria-label="${EXTENSION_STRINGS.loadUnpacked}"]`,
      ]),
    { description: "extension management page" },
  );
}

async function stageUnpackedFolder(app, folder) {
  await stubFolderPicker(app, folder);
  await app.clickSelector(`[aria-label="${EXTENSION_STRINGS.loadUnpacked}"]`);
  await app.waitFor(
    () =>
      app.execute(
        `return Boolean(document.querySelector("#ext-link-folder"));`,
      ),
    {
      description:
        "staged folder import form (the intercepted directory picker has to resolve)",
    },
  );
}

async function uploadArchiveThroughUi(app, archivePath, typedName) {
  // The real control is a hidden file input a button clicks for the user;
  // WebDriver can only type a path into an input it can see.
  await app.execute(`
    const input = document.querySelector("#ext-file-input");
    input.classList.remove("hidden");
    input.style.position = "fixed";
    input.style.left = "12px";
    input.style.bottom = "12px";
  `);
  const input = await app.session.findCss("#ext-file-input");
  await app.session.sendKeys(input, archivePath);
  await app.waitForText(path.basename(archivePath));
  await app.execute(`
    const input = document.querySelector("#ext-file-input");
    input.classList.add("hidden");
    input.removeAttribute("style");
  `);
  await app.fillSelector(
    `input[placeholder="${EXTENSION_STRINGS.namePlaceholder}"]`,
    typedName,
  );
  await app.clickText(en.common.buttons.add, { roles: ["button"] });
}

/** The link checkbox plus the copy that is supposed to explain it. */
async function linkCheckboxState(app, id) {
  return app.execute(
    `const checkbox = document.querySelector("#" + arguments[0]);
     const label = document.querySelector('label[for="' + arguments[0] + '"]');
     const help = label?.parentElement?.querySelector("p");
     return checkbox
       ? {
           checked: checkbox.getAttribute("data-state") === "checked",
           label: (label?.innerText ?? "").trim(),
           help: (help?.innerText ?? "").trim(),
         }
       : null;`,
    [id],
  );
}

function extensionRowScript(body) {
  return `const wanted = arguments[0];
     const row = [...document.querySelectorAll("tbody tr")].find((candidate) => {
       const cells = [...candidate.querySelectorAll("td")];
       return cells.length >= 7 && (cells[2].querySelector("button > span")?.textContent || cells[2].innerText || "").trim() === wanted;
     });
     ${body}`;
}

async function extensionRow(app, name) {
  return app.execute(
    extensionRowScript(`if (!row) return null;
     const cells = [...row.querySelectorAll("td")];
     const sync = row.querySelector('[data-slot="animated-switch"]');
     return {
       name: (cells[2].querySelector("button > span")?.textContent || cells[2].innerText || "").trim(),
       source: (cells[4].innerText || "").trim(),
       syncChecked: sync ? sync.getAttribute("data-state") === "checked" : null,
       syncDisabled: sync ? sync.disabled === true : null,
     };`),
    [name],
  );
}

async function extensionEditButton(app, name) {
  return app.execute(
    extensionRowScript(
      `return row ? row.querySelector("td:last-child button") : null;`,
    ),
    [name],
  );
}

async function dialogText(app, title) {
  return app.execute(
    `const wanted = arguments[0];
     const dialog = [...document.querySelectorAll("[role='dialog']")]
       .reverse()
       .find((node) =>
         [...node.querySelectorAll("[data-slot='dialog-title']")].some(
           (heading) => (heading.textContent || "").trim() === wanted,
         ),
       );
     return dialog ? (dialog.innerText || "").trim() : null;`,
    [title],
  );
}

async function toastTexts(app) {
  return app.execute(
    `return [...document.querySelectorAll("[data-sonner-toast]")]
       .map((toast) => (toast.innerText || "").trim())
       .filter(Boolean);`,
  );
}

test("an uploaded archive and a loaded folder both import, each under its own source", async () => {
  await withApp("ui-extension-import-sources", async (app) => {
    const archivePath = path.join(app.root, "ui-archive-extension.zip");
    await writeFile(archivePath, Buffer.from(extensionZipBase64(), "base64"));
    const folder = await writeUnpackedExtension(
      path.join(app.root, "fixtures", "ui-copied-extension"),
      { name: "Donut UI Copied Folder" },
    );

    await openExtensionsPage(app);
    await uploadArchiveThroughUi(
      app,
      archivePath,
      "Overridden By The Manifest",
    );
    await app.waitForText("Donut E2E Fixture");

    await stageUnpackedFolder(app, folder);
    assert.ok(await app.visibleTextIncludes(EXTENSION_STRINGS.selectedFolder));
    assert.ok(
      await app.visibleTextIncludes(folder),
      "the staged import has to name the folder it is about to read",
    );
    const staged = await linkCheckboxState(app, "ext-link-folder");
    assert.equal(staged?.checked, false, "linking a folder has to be opt-in");
    assert.equal(staged.help, EXTENSION_STRINGS.linkFolderOff);
    await app.clickText(en.common.buttons.add, { roles: ["button"] });
    await app.waitForText("Donut UI Copied Folder");

    const pickerCalls = await restoreFolderPicker(app);
    assert.equal(pickerCalls.length, 1, "Load unpacked has to open the picker");
    assert.equal(pickerCalls[0].options.directory, true);
    assert.equal(pickerCalls[0].options.multiple, false);
    assert.equal(
      pickerCalls[0].options.title,
      EXTENSION_STRINGS.selectFolderTitle,
    );

    assert.notEqual(
      EXTENSION_STRINGS.source.archive,
      EXTENSION_STRINGS.source.unpacked,
    );
    assert.equal(
      (await extensionRow(app, "Donut E2E Fixture"))?.source,
      EXTENSION_STRINGS.source.archive,
    );
    assert.equal(
      (await extensionRow(app, "Donut UI Copied Folder"))?.source,
      EXTENSION_STRINGS.source.unpacked,
    );

    const extensions = await app.invoke("list_extensions");
    assert.equal(extensions.length, 2);
    const copied = extensions.find(
      (extension) => extension.name === "Donut UI Copied Folder",
    );
    assert.equal(copied.source_kind, "unpacked");
    assert.equal(
      copied.linked_path,
      null,
      "an unlinked folder import is copied into the store, not pointed at",
    );
    assert.equal(copied.file_type, "zip");
    const archive = extensions.find(
      (extension) => extension.name === "Donut E2E Fixture",
    );
    assert.equal(archive.source_kind, "archive");
    assert.equal(archive.linked_path, null);
  });
});

test("linking a folder says what it costs, records the path, and locks that row's sync off", async () => {
  await withApp("ui-extension-linked-folder", async (app) => {
    await app.invoke("add_extension", {
      name: "Copied Neighbour",
      fileName: "ui-neighbour-extension.zip",
      fileData: [...Buffer.from(extensionZipBase64(), "base64")],
    });
    const folder = await writeUnpackedExtension(
      path.join(app.root, "fixtures", "ui-linked-extension"),
      { name: "Donut UI Linked Folder" },
    );

    await openExtensionsPage(app);
    await app.waitForText("Donut E2E Fixture");
    await stageUnpackedFolder(app, folder);

    const off = await linkCheckboxState(app, "ext-link-folder");
    assert.equal(off?.checked, false);
    assert.equal(off.label, EXTENSION_STRINGS.linkFolder);
    assert.equal(off.help, EXTENSION_STRINGS.linkFolderOff);

    await app.clickSelector("#ext-link-folder");
    const on = await app.waitFor(
      async () => {
        const state = await linkCheckboxState(app, "ext-link-folder");
        return state?.checked ? state : false;
      },
      { description: "link checkbox to turn on" },
    );
    assert.equal(on.help, EXTENSION_STRINGS.linkFolderOn);
    assert.notEqual(
      on.help,
      off.help,
      "the checkbox has to say what turning it on changes",
    );

    await app.clickText(en.common.buttons.add, { roles: ["button"] });
    await app.waitForText("Donut UI Linked Folder");
    assert.equal((await restoreFolderPicker(app)).length, 1);

    const linkedRow = await extensionRow(app, "Donut UI Linked Folder");
    assert.equal(linkedRow?.source, EXTENSION_STRINGS.source.linked);
    assert.equal(linkedRow.syncChecked, false);
    assert.equal(linkedRow.syncDisabled, true);
    assert.equal(
      (await extensionRow(app, "Donut E2E Fixture"))?.syncDisabled,
      false,
      "only the linked row loses its sync control",
    );

    const linked = (await app.invoke("list_extensions")).find(
      (extension) => extension.name === "Donut UI Linked Folder",
    );
    assert.equal(linked.linked_path, await realpath(folder));
    assert.equal(linked.file_type, "unpacked");
    assert.equal(linked.sync_enabled, false);
  });
});

test("the edit dialog replaces an extension's payload from a folder", async () => {
  await withApp("ui-extension-replace-from-folder", async (app) => {
    const original = await app.invoke("add_extension", {
      name: "Replaced Later",
      fileName: "ui-original-extension.zip",
      fileData: [...Buffer.from(extensionZipBase64(), "base64")],
    });
    assert.equal(original.version, "1.0.0");
    const folder = await writeUnpackedExtension(
      path.join(app.root, "fixtures", "ui-replacement-extension"),
      { name: "Donut UI Replacement", version: "3.1.4" },
    );

    await openExtensionsPage(app);
    await app.waitForText("Donut E2E Fixture");
    const editButton = await extensionEditButton(app, "Donut E2E Fixture");
    assert.ok(editButton, "the extension row's edit control was not visible");
    await app.clickElement(editButton, "extension edit button");
    const beforeReplace = await app.waitFor(
      () => dialogText(app, EXTENSION_STRINGS.editExtension),
      { description: "extension edit dialog" },
    );
    assert.ok(beforeReplace.includes(EXTENSION_STRINGS.source.label));
    assert.ok(beforeReplace.includes(EXTENSION_STRINGS.source.archive));

    await stubFolderPicker(app, folder);
    await app.clickTextIn('[role="dialog"]', EXTENSION_STRINGS.selectFolder, {
      roles: ["button"],
    });
    await app.waitFor(
      async () =>
        (await dialogText(app, EXTENSION_STRINGS.editExtension))?.includes(
          folder,
        ),
      { description: "chosen replacement folder" },
    );
    const replaceLink = await linkCheckboxState(app, "ext-edit-link-folder");
    assert.equal(replaceLink?.checked, false);
    assert.equal(replaceLink.help, EXTENSION_STRINGS.linkFolderOff);

    await app.clickTextIn('[role="dialog"]', en.common.buttons.save, {
      roles: ["button"],
    });
    await app.waitFor(
      async () =>
        (await toastTexts(app)).some((text) =>
          text.includes(EXTENSION_STRINGS.updateSuccess),
        ),
      { description: "extension update confirmation" },
    );
    assert.equal((await restoreFolderPicker(app)).length, 1);

    const extensions = await app.invoke("list_extensions");
    assert.equal(
      extensions.length,
      1,
      "replacing a payload must not add a second extension",
    );
    const [updated] = extensions;
    assert.equal(updated.id, original.id);
    assert.equal(updated.source_kind, "unpacked");
    assert.equal(updated.linked_path, null);
    assert.equal(updated.file_name, "ui-replacement-extension.zip");
    assert.equal(updated.version, "3.1.4");
    // The dialog's own name field stays authoritative, so the row keeps its
    // name while the payload underneath it is swapped.
    assert.equal(updated.name, "Donut E2E Fixture");

    await app.waitFor(
      async () =>
        (await extensionRow(app, "Donut E2E Fixture"))?.source ===
        EXTENSION_STRINGS.source.unpacked,
      { description: "replaced row to report its new source" },
    );
  });
});

test("a folder with no manifest fails with the translated reason, not a raw code", async () => {
  await withApp("ui-extension-manifest-missing", async (app) => {
    const folder = path.join(app.root, "fixtures", "ui-not-an-extension");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "readme.txt"), "no manifest here\n");

    await openExtensionsPage(app);
    await stageUnpackedFolder(app, folder);
    await app.clickText(en.common.buttons.add, { roles: ["button"] });

    const expected = en.backendErrors.extensionManifestMissing;
    await app.waitFor(
      async () =>
        (await toastTexts(app)).some((text) => text.includes(expected)),
      { description: "translated manifest-missing toast" },
    );
    const toasts = await toastTexts(app);
    assert.ok(
      toasts.every((text) => !text.includes("EXTENSION_MANIFEST_MISSING")),
      `a raw backend code reached the user: ${JSON.stringify(toasts)}`,
    );
    assert.ok(
      toasts.every((text) => !text.includes(EXTENSION_STRINGS.uploadFailed)),
      "the generic fallback would hide which folder problem this was",
    );
    assert.deepEqual(await app.invoke("list_extensions"), []);
    assert.equal((await restoreFolderPicker(app)).length, 1);
  });
});

test("scheduled recipes stay behind the plan, and a schedule is built from the form", async () => {
  await withApp(
    "ui-agent-schedules",
    async (app) => {
      const profile = await createUiProfile(app, "Scheduled Profile");
      const user = (plan) => ({
        logged_in_at: new Date().toISOString(),
        user: {
          id: "ui-schedules",
          email: "schedules@example.test",
          plan,
          planPeriod: "monthly",
          subscriptionStatus: "active",
          profileLimit: 50,
          cloudProfilesUsed: 0,
          proxyBandwidthLimitMb: 0,
          proxyBandwidthUsedMb: 0,
          proxyBandwidthExtraMb: 0,
          isPrimaryDevice: true,
        },
      });
      await stubCommand(app, "get_mcp_remote_status", {
        enabled: true,
        connected: true,
        instanceId: "ui-schedules",
        lastError: null,
      });
      await stubCommand(app, "get_agent_recipes", [
        {
          id: "r1",
          name: "Check orders",
          steps: [{ type: "navigate", url: "https://example.com" }],
        },
      ]);
      await stubCommand(app, "list_agent_schedules", [
        {
          id: "s1",
          name: "Hourly check",
          enabled: true,
          target: "fleet",
          recipeId: "r1",
          profileIds: [profile.id],
          groupId: null,
          cadence: "interval",
          daysMask: 31,
          runAtMinute: 540,
          timezone: "UTC",
          runOnceAt: null,
          intervalMinutes: 60,
          nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
          lastRunAt: null,
        },
      ]);
      await stubCommand(app, "create_agent_schedule", { id: "s2" });
      const calls = (command) =>
        app.execute(
          "return (window.__donutStubbedCalls ?? []).filter((c) => c.command === arguments[0]).map((c) => c.payload);",
          [command],
        );

      const signIn = async (plan) => {
        await stubCommand(app, "cloud_get_user", user(plan));
        await app.invoke("plugin:event|emit", {
          event: "cloud-auth-changed",
          payload: null,
        });
      };

      // A plan without schedules never reaches the form.
      await signIn("free");
      await app.clickSelector(`[aria-label="${en.rail.agent}"]`);
      await app.clickSelector('[data-testid="agent-tab-schedules"]');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(
        await app.execute(
          `return !document.querySelector('[data-slot="agent-schedules"]');`,
        ),
        true,
        "the schedules list is not shown without the plan",
      );
      await app.clickSelector(`[aria-label="${en.rail.profiles}"]`);

      await signIn("pro");
      // Turning paid opens the one-time welcome; close it first.
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector('[role="dialog"]'));`,
          ),
        { description: "the paid welcome" },
      );
      await dismissSurface(app);
      await app.waitFor(
        () => app.execute(`return !document.querySelector('[role="dialog"]');`),
        { description: "the welcome closed" },
      );
      await app.clickSelector(`[aria-label="${en.rail.agent}"]`);
      await app.clickSelector('[data-testid="agent-tab-schedules"]');
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('[data-slot="agent-schedule"]')?.innerText ?? null;`,
          ),
        { description: "the stored schedule" },
      );
      const row = await app.execute(
        `return document.querySelector('[data-slot="agent-schedule"]').innerText;`,
      );
      assert.match(row, /Hourly check/);
      assert.match(
        row,
        new RegExp(
          en.agent.schedules.summaryInterval.replace("{{minutes}}", "60"),
        ),
      );

      await app.clickSelector('[data-slot="agent-schedule-new"]');
      await app.fillSelector("#agent-schedule-name", "Weekday check");
      await app.clickSelector(`#agent-schedule-profile-${profile.id}`);
      // A webhook must be https; the form says so and does not save.
      const saveDisabled = () =>
        app.execute(
          `return document.querySelector('[data-slot="agent-schedule-save"]').disabled;`,
        );
      await app.fillSelector(
        "#agent-schedule-webhook",
        "http://hooks.example.test/donut",
      );
      await app.waitFor(saveDisabled, { description: "save refused" });
      await app.fillSelector(
        "#agent-schedule-webhook",
        "https://hooks.example.test/donut",
      );
      await app.waitFor(async () => !(await saveDisabled()), {
        description: "save allowed",
      });
      await app.capture("agent-schedule-editor");
      await app.clickSelector('[data-slot="agent-schedule-save"]');
      await app.waitFor(
        async () => (await calls("create_agent_schedule")).length === 1,
        {
          description: "the schedule sent to the cloud",
        },
      );
      const [created] = await calls("create_agent_schedule");
      assert.equal(created.schedule.name, "Weekday check");
      assert.equal(created.schedule.recipeId, "r1");
      assert.equal(created.schedule.target, "fleet");
      assert.deepEqual(created.schedule.profileIds, [profile.id]);
      assert.equal(created.schedule.cadence, "weekly");
      assert.equal(
        created.schedule.daysMask,
        0b0011111,
        "Monday to Friday by default",
      );
      assert.equal(created.schedule.runAtMinute, 9 * 60);
      assert.ok(created.schedule.timezone);
      assert.equal(created.schedule.enabled, true);
      assert.equal(created.schedule.notifyEmail, true, "email on by default");
      assert.equal(
        created.schedule.webhookUrl,
        "https://hooks.example.test/donut",
      );
      assert.equal(
        created.schedule.intervalMinutes,
        undefined,
        "only the weekly fields",
      );

      // A recipe also runs once on demand: the profile and the place it runs
      // go to the cloud, which replays it.
      await stubCommand(app, "run_agent_recipe_now", { id: "replay-1" });
      await app.clickSelector('[data-testid="agent-tab-recipes"]');
      await app.clickSelector(
        `[data-slot="agent-recipe-run"][aria-label="${en.agent.recipes.runAria.replace("{{name}}", "Check orders")}"]`,
      );
      await app.clickSelector('[data-slot="agent-recipe-run-profile"]');
      await app.clickText("Scheduled Profile", { roles: ["option"] });
      await app.clickSelector('[data-slot="agent-recipe-run-start"]');
      await app.waitFor(
        async () => (await calls("run_agent_recipe_now")).length === 1,
        { description: "the run sent to the cloud" },
      );
      const [run] = await calls("run_agent_recipe_now");
      assert.equal(run.recipeId, "r1");
      assert.equal(run.profileId, profile.id);
      assert.equal(run.target, "desktop", "a connected desktop runs it here");
    },
    { seedDownloadedBrowser: true },
  );
});

test("a launcher seat opens the team's profiles but cannot change them, and an owner reads the team's log", async () => {
  await withApp(
    "ui-team-roles",
    async (app) => {
      const profile = await createUiProfile(app, "Team Profile");
      const group = await app.invoke("create_profile_group", { name: "Shop" });
      const calls = (command) =>
        app.execute(
          "return (window.__donutStubbedCalls ?? []).filter((c) => c.command === arguments[0]).map((c) => c.payload);",
          [command],
        );
      const user = (teamRole) => ({
        logged_in_at: new Date().toISOString(),
        user: {
          id: "ui-team-seat",
          email: "seat@example.test",
          plan: "team",
          planPeriod: "monthly",
          subscriptionStatus: "active",
          profileLimit: 50,
          cloudProfilesUsed: 0,
          proxyBandwidthLimitMb: 0,
          proxyBandwidthUsedMb: 0,
          proxyBandwidthExtraMb: 0,
          isPrimaryDevice: true,
          teamId: "team-1",
          teamName: "Shop team",
          teamRole,
        },
      });
      const signIn = async (teamRole) => {
        await stubCommand(app, "cloud_get_user", user(teamRole));
        await app.invoke("plugin:event|emit", {
          event: "cloud-auth-changed",
          payload: null,
        });
      };
      // A paid seat opens the one-time welcome; close it when it comes.
      const closeWelcome = async () => {
        const opened = await app
          .waitFor(
            () =>
              app.execute(
                `return Boolean(document.querySelector('[role="dialog"]'));`,
              ),
            { timeoutMs: 4000, description: "the paid welcome" },
          )
          .catch(() => false);
        if (!opened) return;
        await dismissSurface(app);
        await app.waitFor(
          () =>
            app.execute(`return !document.querySelector('[role="dialog"]');`),
          { description: "the welcome closed" },
        );
      };

      const launcherSeat = path.join(app.root, "donut", "e2e-team-read-only");
      await writeFile(launcherSeat, "");
      await signIn("launcher");
      await closeWelcome();
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('[data-testid="team-read-only-notice"]')?.innerText ?? null;`,
          ),
        { description: "the launcher notice" },
      );
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('[data-tip-anchor="new-profile"]'));`,
        ),
        false,
        "a launcher is not offered a new profile",
      );
      await app.capture("team-launcher-profiles");

      // The app refuses the edit itself; the profile stays as the team set it.
      assert.match(
        await app.invokeError("rename_profile", {
          profileId: profile.id,
          newName: "Renamed by a launcher",
        }),
        /"code":"TEAM_ROLE_READ_ONLY"/,
      );
      assert.match(
        await app.invokeError("create_profile_group", { name: "Blocked" }),
        /"code":"TEAM_ROLE_READ_ONLY"/,
      );
      const profiles = await app.invoke("list_browser_profiles");
      assert.equal(
        profiles.find((p) => p.id === profile.id)?.name,
        "Team Profile",
      );

      await stubCommand(app, "list_team_activity", {
        items: [
          {
            id: 3,
            at: new Date().toISOString(),
            actor: {
              userId: "u-admin",
              email: "admin@example.test",
              kind: "desktop",
            },
            action: "profile.update",
            target: { type: "profile", id: profile.id, name: null },
            detail: { fields: ["tags", "dns_server"] },
            source: "client",
          },
          {
            id: 2,
            at: new Date(Date.now() - 60_000).toISOString(),
            actor: {
              userId: "u-launcher",
              email: "launcher@example.test",
              kind: "desktop",
            },
            action: "profile.launch",
            target: { type: "profile", id: profile.id, name: null },
            detail: null,
            source: "server",
          },
          {
            id: 1,
            at: new Date(Date.now() - 120_000).toISOString(),
            actor: {
              userId: "u-launcher",
              email: "launcher@example.test",
              kind: "web",
            },
            action: "member.join",
            target: { type: "member", id: "u-launcher", name: null },
            detail: null,
            source: "server",
          },
        ],
        nextCursor: null,
      });
      await rm(launcherSeat);
      await stubCommand(app, "list_team_members", [
        {
          userId: "ui-team-seat",
          email: "seat@example.test",
          role: "owner",
          groupAccess: null,
        },
        {
          userId: "u-admin",
          email: "admin@example.test",
          role: "admin",
          groupAccess: null,
        },
        {
          userId: "u-launcher",
          email: "launcher@example.test",
          role: "launcher",
          groupAccess: null,
        },
      ]);
      await signIn("owner");
      await closeWelcome();
      await app.clickSelector(`[aria-label="${en.rail.account}"]`);
      await app.clickText(en.account.tabs.teamActivity, { roles: ["tab"] });
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelectorAll('[data-testid="team-activity"] li').length === 3;`,
          ),
        { description: "the team's log" },
      );
      const rows = await app.execute(
        `return [...document.querySelectorAll('[data-testid="team-activity"] li')].map((row) => row.innerText);`,
      );
      // An id in the log reads as the name this computer has for it.
      assert.match(
        rows[0],
        new RegExp(
          en.teamActivity.actions.profileUpdate.replace(
            "{{target}}",
            "Team Profile",
          ),
        ),
      );
      assert.match(rows[0], new RegExp(en.teamActivity.fields.dnsServer));
      assert.match(rows[0], new RegExp(en.teamActivity.via.desktop));
      assert.match(
        rows[1],
        new RegExp(
          en.teamActivity.actions.profileLaunch.replace(
            "{{target}}",
            "Team Profile",
          ),
        ),
      );
      assert.match(rows[2], new RegExp(en.teamActivity.actions.memberJoin));
      await app.capture("team-activity-log");

      // A filter reads the log again, narrowed in the cloud.
      await app.clickSelector('[data-testid="team-activity-member"]');
      await app.clickText("launcher@example.test", { roles: ["option"] });
      await app.waitFor(
        async () =>
          (await calls("list_team_activity")).some(
            (payload) => payload?.filter?.actorUserId === "u-launcher",
          ),
        { description: "the log read for one member" },
      );

      // The export saves what the filters show.
      await stubCommand(app, "plugin:dialog|save", "/tmp/team-activity.csv");
      await stubCommand(app, "export_team_activity_csv", 3);
      await app.clickSelector('[data-testid="team-activity-export"]');
      await app.waitFor(
        async () => (await calls("export_team_activity_csv")).length === 1,
        { description: "the CSV export" },
      );
      const [exported] = await calls("export_team_activity_csv");
      assert.equal(exported.path, "/tmp/team-activity.csv");
      assert.equal(exported.filter.actorUserId, "u-launcher");

      // Access by group: the owner limits the launcher to one group.
      await app.clickText(en.account.tabs.teamAccess, { roles: ["tab"] });
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelectorAll('[data-testid="team-access"] li').length === 3;`,
          ),
        { description: "the team's members" },
      );
      assert.equal(
        await app.execute(
          `return document.querySelectorAll('[data-member="ui-team-seat"] button').length;`,
        ),
        0,
        "the owner is never limited",
      );
      await stubCommand(app, "set_team_member_access", {
        userId: "u-launcher",
        email: "launcher@example.test",
        role: "launcher",
        groupAccess: [group.id],
      });
      await app.clickSelector('[data-member="u-launcher"] button');
      await app.clickSelector('label[for="access-some-u-launcher"]');
      await app.clickSelector(`#access-u-launcher-${group.id}`);
      await app.capture("team-access-editor");
      await app.clickSelector('[data-testid="team-access-save"]');
      await app.waitFor(
        async () => (await calls("set_team_member_access")).length === 1,
        { description: "the access sent to the cloud" },
      );
      const [access] = await calls("set_team_member_access");
      assert.deepEqual(access, { userId: "u-launcher", groups: [group.id] });
      await app.waitFor(
        async () =>
          (
            await app.execute(
              `return document.querySelector('[data-member="u-launcher"]')?.innerText ?? "";`,
            )
          ).includes(en.teamAccess.someGroups_one.replace("{{count}}", "1")),
        { description: "the new access on the row" },
      );
      await dismissSurface(app);
    },
    { seedDownloadedBrowser: true },
  );
});

test("the agent page guides setup, then shows agents, requests, notes, take-overs and the pause live", async () => {
  await withApp(
    "ui-agent",
    async (app) => {
      await app.waitForText("No profiles yet");
      const painted = (testId) =>
        app.execute(
          `const el = document.querySelector('[data-testid="' + arguments[0] + '"]');
         if (!el) return null;
         const rect = el.getBoundingClientRect();
         const style = getComputedStyle(el);
         return rect.width > 0 && rect.height > 0 && Number(style.opacity) === 1 && style.visibility === "visible"
           ? el.innerText.trim()
           : null;`,
          [testId],
        );
      const waitPainted = (testId) =>
        app.waitFor(() => painted(testId), { description: testId });
      const absent = (testId) =>
        app.waitFor(
          () =>
            app.execute(
              `return !document.querySelector('[data-testid="' + arguments[0] + '"]');`,
              [testId],
            ),
          { description: `${testId} gone` },
        );

      // Signed out, the page says what is missing instead of showing controls.
      await app.clickSelector(`[aria-label="${en.rail.agent}"]`);
      const signedOut = await waitPainted("agent-setup-signed-out");
      assert.match(signedOut, new RegExp(en.agent.setup.signedOutTitle));
      assert.equal(await painted("agent-pause-switch"), null);
      // Leaving the page unmounts it, so the next visit reads the stubs below.
      await app.clickSelector(`[aria-label="${en.rail.profiles}"]`);
      await absent("agent-page");

      const profile = await createUiProfile(app, "Agent UI Profile");
      const now = Date.now();
      try {
        await stubCommand(app, "cloud_get_user", {
          logged_in_at: new Date().toISOString(),
          user: {
            id: "ui-agent",
            email: "agent@example.test",
            plan: "pro",
            planPeriod: "monthly",
            subscriptionStatus: "active",
            profileLimit: 50,
            cloudProfilesUsed: 0,
            proxyBandwidthLimitMb: 0,
            proxyBandwidthUsedMb: 0,
            proxyBandwidthExtraMb: 0,
            isPrimaryDevice: true,
          },
        });
        await stubCommand(app, "get_mcp_remote_status", {
          enabled: true,
          connected: true,
          instanceId: "ui-agent-instance",
          lastError: null,
        });
        const base = {
          session_id: "ui-s1",
          profile_id: null,
          choices: [],
          answer: null,
          answered_at: null,
          delivered_to: [],
          done: null,
          total: null,
        };
        const question = {
          ...base,
          id: 9001,
          at: now - 5000,
          kind: "question",
          text: "Which shipping address should I use?",
          choices: ["Home", "Office"],
          state: "open",
        };
        const help = {
          ...base,
          id: 9002,
          at: now - 4000,
          kind: "help",
          text: "Solve the verification on the sign-in page",
          profile_id: profile.id,
          state: "open",
        };
        await stubCommand(app, "get_agent_console", {
          sessions: [
            {
              session_id: "ui-s1",
              client_name: "Claude Code",
              client_version: "2.1.0",
              connected_at: now - 60_000,
              last_seen_at: now - 1000,
              calls: 3,
              errors: 1,
              ended: false,
              status: {
                message: "Checking orders",
                done: 2,
                total: 5,
                profile_id: null,
                updated_at: now - 2000,
              },
            },
          ],
          activity: [
            {
              id: 9100,
              at: now - 3000,
              session_id: "ui-s1",
              tool: "navigate",
              profile_id: profile.id,
              profile_count: null,
              ok: true,
              error_code: null,
              duration_ms: 420,
              detail: "shop.example.com",
            },
            {
              id: 9101,
              at: now - 2500,
              session_id: "ui-s1",
              tool: "click_locator",
              profile_id: profile.id,
              profile_count: null,
              ok: false,
              error_code: "LOCATOR_NO_MATCH",
              duration_ms: 90,
              detail: null,
            },
          ],
          thread: [question, help],
          holds: [
            {
              profile_id: profile.id,
              since: now - 4000,
              note: null,
              request_id: 9002,
            },
          ],
          paused: null,
          quota: { limit: 2000, used: 240, resets_in_secs: 1200 },
        });
        await stubCommand(app, "answer_agent_request", {
          ...question,
          state: "answered",
          answer: "Office",
          answered_at: now,
        });
        await app.invoke("plugin:event|emit", {
          event: "cloud-auth-changed",
          payload: null,
        });
        await app.invoke("plugin:event|emit", {
          event: "agent-console-cleared",
          payload: null,
        });

        // Two open requests reach the rail before the page is opened.
        await app.waitFor(
          async () => (await painted("agent-rail-badge")) === "2",
          { description: "the rail badge counts open requests" },
        );
        const waitingLabel = en.rail.agentWaiting.replace("{{count}}", "2");
        await app.clickSelector(`[aria-label="${waitingLabel}"]`);
        await waitPainted("agent-needs-you");
        // The page holds the seeded snapshot now; later reads go to the backend.
        await app.execute(`delete window.__donutStubs.get_agent_console;`);
        await app.capture("agent-conversation");
        // The Conversation tab carries the open-request count after its label.
        assert.deepEqual(
          await app.execute(
            `return [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent.trim().replace(/\\d+$/, ""));`,
          ),
          [
            en.agent.tabs.conversation,
            en.agent.tabs.profiles,
            en.agent.tabs.activity,
            en.agent.tabs.recipes,
            en.agent.tabs.schedules,
          ],
        );
        assert.match(await painted("agent-quota"), /1[,.\s ]?760/);
        assert.match(await painted("agent-session-ui-s1"), /Claude Code/);
        assert.match(await painted("agent-session-ui-s1"), /Checking orders/);
        assert.match(
          await painted("agent-request-9001"),
          /Which shipping address should I use\?/,
        );
        assert.match(
          await painted("agent-request-9002"),
          /Solve the verification on the sign-in page/,
        );
        assert.equal(
          await app.execute(
            `return document.querySelectorAll('[data-testid="agent-request-9001"] [data-testid="agent-choice"]').length;`,
          ),
          2,
        );

        // A suggested answer is one click, and the card leaves the list.
        await app.clickText("Office", { roles: ["button"] });
        await absent("agent-request-9001");
        const answered = await app.execute(
          `return (window.__donutStubbedCalls ?? []).filter((c) => c.command === "answer_agent_request").map((c) => c.payload);`,
        );
        assert.deepEqual(answered, [{ requestId: 9001, answer: "Office" }]);

        // Real backend events update the open page: a note, then the pause.
        await app.invoke("send_agent_note", {
          text: "Use the EU shipping profile today",
        });
        await app.waitFor(
          async () =>
            ((await painted("agent-thread")) ?? "").includes(
              "Use the EU shipping profile today",
            ),
          { description: "the note in the thread" },
        );
        await app.invoke("set_agents_paused", {
          paused: true,
          note: "Changing proxies",
        });
        assert.match(
          await waitPainted("agent-paused-banner"),
          /Changing proxies/,
        );
        await app.clickSelector('[data-testid="agent-resume"]');
        await absent("agent-paused-banner");
        assert.equal((await app.invoke("get_agent_console")).paused, null);

        // Profiles: the agent's profile is listed with its last error, and the
        // person can take it over and hand it back.
        await app.clickSelector('[data-testid="agent-tab-profiles"]');
        const row = await waitPainted(`agent-profile-${profile.id}`);
        assert.match(row, /Agent UI Profile/);
        assert.match(row, /LOCATOR_NO_MATCH/);
        assert.deepEqual(
          await offCenterSelectionControls(
            app,
            '[data-testid="agent-profiles"]',
          ),
          [],
        );
        await app.clickSelector(
          `[data-testid="agent-profile-${profile.id}"] [data-testid="agent-take-over"]`,
        );
        await app.fillSelector(
          '[data-testid="agent-take-over-note"]',
          "Fixing the address",
        );
        await app.clickSelector('[data-testid="agent-take-over-confirm"]');
        await app.waitFor(
          async () =>
            (await app.invoke("get_agent_console")).holds.some(
              (hold) =>
                hold.profile_id === profile.id &&
                hold.note === "Fixing the address",
            ),
          { description: "the take-over reached the backend" },
        );
        await app.waitFor(
          () =>
            app.execute(
              `return Boolean(document.querySelector('[data-testid="agent-profile-' + arguments[0] + '"] [data-testid="agent-hand-back"]'));`,
              [profile.id],
            ),
          { description: "the row offers hand back" },
        );
        await app.clickSelector(
          `[data-testid="agent-profile-${profile.id}"] [data-testid="agent-hand-back"]`,
        );
        await app.clickSelector('[data-testid="agent-hand-back-confirm"]');
        await app.waitFor(
          async () =>
            (await app.invoke("get_agent_console")).holds.length === 0,
          { description: "the hand-back reached the backend" },
        );

        await app.clickSelector('[data-testid="agent-tab-activity"]');
        const activity = await waitPainted("agent-activity-list");
        assert.match(activity, /shop\.example\.com/);
        assert.match(activity, /LOCATOR_NO_MATCH/);
        await app.capture("agent-page");
        await dismissSurface(app);

        // The palette reaches the same page.
        const modifier =
          process.platform === "darwin" ? { meta: true } : { ctrl: true };
        await app.pressShortcut({ key: "k", ...modifier });
        await app.waitFor(
          () =>
            app.execute(
              `return Boolean(document.querySelector("[cmdk-input]"));`,
            ),
          { description: "command palette" },
        );
        const input = await app.session.findCss("[cmdk-input]");
        await app.session.sendKeys(input, en.shortcuts.goAgent);
        await app.clickText(en.shortcuts.goAgent, {
          exact: false,
          roles: ["option", "button", "menuitem"],
        });
        await waitPainted("agent-page");
        await dismissSurface(app);
      } finally {
        await restoreStubs(app);
      }
    },
    { settings: { paid_welcome_seen_for: ["ui-agent"] } },
  );
});

async function createUiProfile(app, name) {
  return app.invoke("create_browser_profile_new", {
    name,
    browserStr: "wayfern",
    version: "150.0.7871.100",
    releaseType: "stable",
    proxyId: null,
    vpnId: null,
    wayfernConfig: { fingerprint: "{}" },
    groupId: null,
    ephemeral: false,
    dnsBlocklist: null,
    launchHook: null,
  });
}

async function distributionSummary(app) {
  return app.execute(
    `return document.querySelector('[data-testid="distribute-summary"]')?.innerText ?? "";`,
  );
}

test("the distribute-proxies dialog opens from the action bar, counts the pairing, and answers every control", async () => {
  await withApp(
    "ui-proxy-distribution",
    async (app) => {
      for (const name of ["Fleet One", "Fleet Two", "Fleet Three"]) {
        await createUiProfile(app, name);
      }
      for (const [index, name] of ["Exit One", "Exit Two"].entries()) {
        await app.invoke("create_stored_proxy", {
          name,
          proxySettings: {
            proxy_type: "http",
            host: "127.0.0.1",
            port: 9101 + index,
            username: null,
            password: null,
          },
        });
      }
      await app.waitForText("Fleet Three");

      await app.clickSelector(`[aria-label="${en.common.aria.selectAll}"]`);
      await app.clickText(en.tables.moreActions, { roles: ["button"] });
      await app.clickText(en.profiles.actionBar.distributeProxies, {
        roles: ["menuitem"],
      });
      await app.waitForText(en.proxyDistribution.title);

      // Two proxies for three profiles: the dialog has to say so up front, and
      // it must never pretend the third profile is covered.
      await app.waitFor(
        async () => (await distributionSummary(app)).includes("2 of 3"),
        { description: "distribution summary" },
      );
      const summary = await distributionSummary(app);
      assert.match(summary, /2 of 3/);
      // The remainder is never silently dropped: the one profile no proxy was
      // left for is named. Which one depends on the table's order, so assert
      // that exactly one of the three is named rather than pinning the sort.
      const named = ["Fleet One", "Fleet Two", "Fleet Three"].filter((name) =>
        summary.includes(name),
      );
      assert.deepEqual(
        named.length,
        1,
        `the unpaired profile must be named exactly once, got: ${summary}`,
      );

      // Every control answers a click. Dropping the proxies empties the plan...
      await app.clickSelector('[data-testid="distribute-toggle-proxies"]');
      await app.waitFor(
        async () => (await distributionSummary(app)).includes("0 of 3"),
        { description: "summary after clearing the proxies" },
      );
      // ...and putting them back restores it.
      await app.clickSelector('[data-testid="distribute-toggle-proxies"]');
      await app.waitFor(
        async () => (await distributionSummary(app)).includes("2 of 3"),
        { description: "summary after reselecting the proxies" },
      );

      const switchState = () =>
        app.execute(
          `return document.querySelector('[aria-label="${en.proxyDistribution.allowSharingLabel}"]')?.getAttribute("aria-checked") ?? null;`,
        );
      assert.equal(await switchState(), "false", "sharing is off by default");
      await app.clickSelector(
        `[aria-label="${en.proxyDistribution.allowSharingLabel}"]`,
      );
      await app.waitFor(async () => (await switchState()) === "true", {
        description: "sharing switch turning on",
      });

      // Dropping every profile leaves nothing to do, and the primary action
      // must not offer to do it.
      await app.clickSelector('[data-testid="distribute-toggle-profiles"]');
      await app.waitFor(
        async () => (await distributionSummary(app)).includes("0 of 0"),
        { description: "summary after clearing the profiles" },
      );
      assert.equal(
        await app.execute(
          `const nodes = [...document.querySelectorAll("button")];
           const node = nodes.find((n) => (n.innerText ?? "").trim().includes(arguments[0]));
           return node ? node.disabled : null;`,
          [en.proxyDistribution.distributeButton],
        ),
        true,
        "an empty plan must not offer a Distribute button that does nothing",
      );

      await dismissSurface(app);
    },
    { seedDownloadedBrowser: true },
  );
});

test("bulk edit opens from the action bar and changes only the ticked rows", async () => {
  await withApp(
    "ui-bulk-edit",
    async (app) => {
      for (const name of ["Batch One", "Batch Two"]) {
        await createUiProfile(app, name);
      }
      await app.invoke("update_profile_note", {
        profileId: (await app.invoke("list_browser_profiles"))[0].id,
        note: "Keep me",
      });
      await app.waitForText("Batch Two");

      await app.clickSelector(`[aria-label="${en.common.aria.selectAll}"]`);
      await app.clickSelector(`[aria-label="${en.bulkEdit.action}"]`);
      await app.waitForText(en.bulkEdit.title);

      const applyDisabled = () =>
        app.execute(
          `return document.querySelector('[data-slot="bulk-edit-apply"]')?.disabled ?? null;`,
        );
      assert.equal(
        await applyDisabled(),
        true,
        "nothing ticked, nothing to apply",
      );
      await app.waitForText(en.bulkEdit.apply_other.replace("{{count}}", "2"));

      await app.clickSelector("#bulk-edit-tagsAdd");
      await app.fillSelector('[data-field="tagsAdd"] input', "ui-bulk, shop");
      assert.equal(await applyDisabled(), false);
      await app.capture("bulk-edit-dialog");
      await app.clickSelector('[data-slot="bulk-edit-apply"]');

      await app.waitFor(
        async () =>
          (await app.invoke("list_browser_profiles")).every(
            (profile) =>
              profile.tags?.includes("ui-bulk") &&
              profile.tags.includes("shop"),
          ),
        { description: "tags on every selected profile" },
      );
      await app.waitFor(
        async () => !(await app.visibleTextIncludes(en.bulkEdit.title)),
        { description: "dialog closing after apply" },
      );
      const notes = (await app.invoke("list_browser_profiles")).map(
        (profile) => profile.note ?? null,
      );
      assert.ok(notes.includes("Keep me"), "an unticked field stays as it is");
    },
    { seedDownloadedBrowser: true },
  );
});

test("templates save from the create dialog and the inspector, and several profiles go to one batch", async () => {
  await withApp(
    "ui-templates",
    async (app) => {
      await stubCommand(app, "is_geoip_database_available", true);
      const base = await createUiProfile(app, "Template Base");
      await app.waitForText(base.name);
      const templates = () => app.invoke("list_profile_templates");

      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Batch");
      await app.clickSelector('[data-slot="template-picker"]');
      await app.waitForText(en.templates.empty);
      await app.fillSelector('[data-slot="template-name"]', "Quick");
      await app.clickSelector('[data-slot="template-save"]');
      await app.waitFor(
        async () => (await templates()).some((t) => t.name === "Quick"),
        { description: "the template saved from the form" },
      );
      const [quick] = await templates();
      assert.equal(quick.settings.name_prefix, "Batch");
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('[data-slot="template-picker"]')?.innerText.includes("Quick") ?? false;`,
          ),
        { description: "the saved template shown as applied" },
      );

      // The count moves nothing: every footer control keeps its place and
      // size, and the dialog keeps its height.
      const single = await createFooterLayout(app);
      await app.clickSelector('[data-slot="profile-count-more"]');
      await app.clickSelector('[data-slot="profile-count-more"]');
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('#profile-count')?.value === "3";`,
          ),
        { description: "three profiles" },
      );
      assert.deepEqual(await createFooterLayout(app), single);
      // The names the batch gets show on the stepper, not in the form.
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('[data-slot="profile-count-hint"]')?.innerText.includes(arguments[0]) ?? false;`,
            [en.templates.namesHint.replaceAll("{{name}}", "Batch")],
          ),
        { description: "the names hint on the stepper" },
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('#enable-password')?.disabled ?? null;`,
        ),
        true,
        "a password is for one profile only",
      );
      await app.capture("templates-create-many");

      await stubCommand(app, "bulk_create_profiles", {
        created: [{ id: "a" }, { id: "b" }, { id: "c" }],
        error: null,
        cancelled: false,
      });
      await app.clickSelector('[data-slot="profile-create-submit"]');
      await app.waitFor(
        () => app.execute(`return !document.querySelector('#profile-name');`),
        { description: "the dialog closing after the batch" },
      );
      const [call] = await app.execute(
        `return (window.__donutStubbedCalls ?? []).filter((c) => c.command === "bulk_create_profiles");`,
      );
      assert.equal(call.payload.count, 3);
      assert.equal(call.payload.name, "Batch");
      assert.equal(call.payload.settings.name_prefix, "Batch");
      await app.waitForText(
        en.templates.created_other.replace("{{count}}", "3"),
      );

      await openProfileCreation(app);
      await app.clickSelector('[data-slot="template-picker"]');
      await app.clickSelector('[data-slot="template-option"]');
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('#profile-name')?.value === "Batch";`,
          ),
        { description: "the template's name prefix filling an empty name" },
      );
      await app.clickSelector('[data-slot="template-picker"]');
      // With the trash on, the template goes to the trash at once: no
      // confirmation, and the toast offers Undo.
      await app.clickSelector('[data-slot="template-delete"]');
      await app.waitFor(async () => (await templates()).length === 0, {
        description: "the template deleted from the picker",
      });
      await app.waitForText(en.trash.moved.replace("{{name}}", "Quick"));
      assert.ok(
        (await app.invoke("list_trashed_entities")).some(
          (entry) => entry.kind === "template" && entry.id === quick.id,
        ),
        "the template waits in the trash",
      );
      await dismissSurface(app);
      await dismissSurface(app);

      await app.clickSelector(
        `[data-slot="profile-inspect-trigger"][data-profile-id="${base.id}"]`,
      );
      await app.clickSelector('[data-slot="profile-info-more"]');
      await app.clickSelector('[data-slot="profile-info-save-template"]');
      await app.waitForText(en.templates.saveFromProfileDescription);
      await app.clickSelector('[data-slot="save-template-confirm"]');
      await app.waitFor(
        async () => (await templates()).some((t) => t.name === "Template Base"),
        { description: "the template saved from the inspector" },
      );
    },
    { seedDownloadedBrowser: true },
  );
});

test("the trash page lists deleted entities by kind and restores one", async () => {
  await withApp("ui-trash-page", async (app) => {
    const group = await app.invoke("create_profile_group", {
      name: "Trash Page Group",
    });
    const proxy = await app.invoke("create_stored_proxy", {
      name: "Trash Page Proxy",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 8091,
        username: null,
        password: null,
      },
    });
    await app.invoke("trash_entity", { kind: "group", id: group.id });
    await app.invoke("trash_entity", { kind: "proxy", id: proxy.id });
    const hasRow = (id) =>
      app.execute(
        `return Boolean(document.querySelector('[data-table-row="' + arguments[0] + '"]'));`,
        [id],
      );

    const modifier =
      process.platform === "darwin" ? { meta: true } : { ctrl: true };
    await app.pressShortcut({ ...modifier, shift: true, key: "t" });
    await app.waitFor(() => hasRow(`group:${group.id}`), {
      description: "the trashed group on the trash page",
    });
    assert.equal(await hasRow(`proxy:${proxy.id}`), true);

    // A kind tab shows that kind only.
    await app.clickSelector('[role="tab"][data-kind="proxy"]');
    await app.waitFor(async () => !(await hasRow(`group:${group.id}`)), {
      description: "the proxy tab hides the group",
    });
    assert.equal(await hasRow(`proxy:${proxy.id}`), true);

    await app.clickSelector(
      `[data-table-row="proxy:${proxy.id}"] [data-slot="trash-restore"]`,
    );
    await app.waitFor(
      async () =>
        (await app.invoke("get_stored_proxies")).some(
          (item) => item.id === proxy.id,
        ),
      { description: "the proxy restored" },
    );
    // The emptied tab falls back to everything that is left.
    await app.waitFor(() => hasRow(`group:${group.id}`), {
      description: "the list falls back to all kinds",
    });
    assert.deepEqual(
      (await app.invoke("list_trashed_entities")).map((entry) => entry.id),
      [group.id],
    );
    await app.capture("trash-page");
  });
});

test("the group bookmark editor adds, reorders and removes a row", async () => {
  await withApp("ui-group-bookmarks", async (app) => {
    const group = await app.invoke("create_profile_group", { name: "Client" });

    await app.clickSelector('[aria-label="Groups"]');
    await app.waitForText("Client");
    await app.clickSelector('[data-testid="group-bookmarks-button"]');
    await app.waitForText(en.groupBookmarks.description);
    assert.ok(await app.visibleTextIncludes(en.groupBookmarks.empty));

    const rowCount = () =>
      app.execute(
        `return document.querySelectorAll('[data-testid="group-bookmark-row"]').length;`,
      );
    const titles = () =>
      app.execute(
        `return [...document.querySelectorAll('[data-testid="group-bookmark-title"]')].map((n) => n.value);`,
      );
    const rowSelector = (index, testid) =>
      `[data-testid="group-bookmark-rows"] > div:nth-child(${index}) [data-testid="${testid}"]`;

    await app.clickSelector('[data-testid="group-bookmark-add"]');
    await app.waitFor(async () => (await rowCount()) === 1, {
      description: "the first bookmark row",
    });
    await app.clickSelector('[data-testid="group-bookmark-add"]');
    await app.waitFor(async () => (await rowCount()) === 2, {
      description: "the second bookmark row",
    });
    await app.clickSelector('[data-testid="group-bookmark-add"]');
    await app.waitFor(async () => (await rowCount()) === 3, {
      description: "the third bookmark row",
    });

    await app.fillSelector(rowSelector(1, "group-bookmark-title"), "Support");
    await app.fillSelector(
      rowSelector(1, "group-bookmark-url"),
      "https://support.example",
    );
    await app.fillSelector(rowSelector(2, "group-bookmark-title"), "Console");
    await app.fillSelector(
      rowSelector(2, "group-bookmark-url"),
      "https://console.example",
    );
    await app.fillSelector(rowSelector(2, "group-bookmark-folder"), "Ops");
    await app.fillSelector(rowSelector(3, "group-bookmark-title"), "Scratch");
    await app.fillSelector(
      rowSelector(3, "group-bookmark-url"),
      "https://scratch.example",
    );
    assert.deepEqual(await titles(), ["Support", "Console", "Scratch"]);

    // Reorder: the second row moves above the first.
    await app.clickSelector(rowSelector(2, "group-bookmark-move-up"));
    await app.waitFor(async () => (await titles())[0] === "Console", {
      description: "the reordered first row",
    });
    assert.deepEqual(await titles(), ["Console", "Support", "Scratch"]);

    // Remove: the last row goes away and nothing else moves.
    await app.clickSelector(rowSelector(3, "group-bookmark-remove"));
    await app.waitFor(async () => (await rowCount()) === 2, {
      description: "the removed row",
    });
    assert.deepEqual(await titles(), ["Console", "Support"]);

    await app.clickText(en.common.buttons.save);
    await app.waitFor(
      async () =>
        (await app.invoke("get_group_bookmarks", { groupId: group.id }))
          .length === 2,
      { description: "the saved bookmark list" },
    );
    assert.deepEqual(
      await app.invoke("get_group_bookmarks", { groupId: group.id }),
      [
        { title: "Console", url: "https://console.example", folder: "Ops" },
        { title: "Support", url: "https://support.example" },
      ],
    );

    await dismissSurface(app);
  });
});

test("importing from a link validates the input and names the extension before it is saved", async () => {
  await withApp("ui-extension-from-link", async (app) => {
    const fixtureBase = process.env.DONUT_E2E_FIXTURE_URL;
    assert.ok(fixtureBase, "the fixture server URL has to reach the suite");

    await openExtensionsPage(app);
    await app.clickSelector(`[aria-label="${EXTENSION_STRINGS.fromUrl}"]`);
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector("#ext-url-input"));`,
        ),
      { description: "the link import form" },
    );

    // Nothing to fetch yet, so the action is not offered.
    assert.equal(
      await app.execute(
        `return [...document.querySelectorAll("button")]
           .find((button) => (button.textContent || "").trim() === arguments[0])
           ?.disabled ?? null;`,
        [EXTENSION_STRINGS.fetchExtension],
      ),
      true,
      "Fetch has to stay disabled until there is something to fetch",
    );

    // A link that is not an extension source is refused, in the user's
    // language, and nothing is staged.
    await app.fillSelector("#ext-url-input", "https://example.invalid/page");
    await app.clickText(EXTENSION_STRINGS.fetchExtension, {
      roles: ["button"],
    });
    await app.waitFor(
      async () =>
        (await toastTexts(app)).some((text) =>
          text.includes(en.backendErrors.extensionUrlInvalid),
        ),
      { description: "the refusal for a link that is not an extension" },
    );
    assert.equal(
      await app.execute(
        `return document.querySelector('[data-slot="extension-fetched-identity"]') === null;`,
      ),
      true,
      "a refused link must not stage anything",
    );

    // The real thing: a CRX3 the fixture server serves. The staged form has to
    // show the identity read out of the archive's own manifest, not the file
    // name, before the user commits to storing it.
    await app.fillSelector("#ext-url-input", `${fixtureBase}/extension.crx`);
    await app.clickText(EXTENSION_STRINGS.fetchExtension, {
      roles: ["button"],
    });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector('[data-slot="extension-fetched-identity"]')?.innerText?.trim() ?? null;`,
        ),
      { description: "the parsed identity of the downloaded extension" },
    );
    const identity = await app.execute(
      `return document.querySelector('[data-slot="extension-fetched-identity"]').innerText.trim();`,
    );
    assert.ok(
      identity.includes(CRX_EXTENSION_NAME),
      `the staged identity has to name the extension, got: ${identity}`,
    );
    assert.ok(
      identity.includes(CRX_EXTENSION_VERSION),
      `the staged identity has to carry the version, got: ${identity}`,
    );
    assert.ok(
      await app.visibleTextIncludes(`${fixtureBase}/extension.crx`),
      "the staged import has to name where the package came from",
    );
    assert.deepEqual(
      await app.invoke("list_extensions"),
      [],
      "fetching stages the archive; it must not store it",
    );

    await app.clickText(en.common.buttons.add, { roles: ["button"] });
    await app.waitForText(CRX_EXTENSION_NAME);
    const stored = await app.invoke("list_extensions");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, CRX_EXTENSION_NAME);
    assert.equal(stored[0].version, CRX_EXTENSION_VERSION);
    assert.equal(stored[0].file_type, "zip");
    assert.equal(stored[0].source_kind, "archive");
  });
});

/** Theme tokens as the browser computes them, so they compare with any
 * element's computed colour whatever notation the theme uses. */
async function themeTokenColors(app) {
  return app.execute(`
    const probe = document.createElement("span");
    document.body.append(probe);
    const resolve = (name) => {
      probe.style.color = "var(" + name + ")";
      return getComputedStyle(probe).color;
    };
    const tokens = {
      muted: resolve("--muted-foreground"),
      warning: resolve("--warning"),
      warningText: resolve("--warning-text"),
    };
    probe.remove();
    return tokens;
  `);
}

test("entity pages teach when empty, label protocols neutrally, and reach row actions by keyboard", async () => {
  await withApp("ui-entity-pages", async (app) => {
    const emptyState = (entity) =>
      `[data-slot="entity-empty-state"][data-entity="${entity}"]`;

    // Nothing stored yet: the page says what a group is for, and its one
    // action makes the first one.
    await app.clickSelector(`[aria-label="${en.rail.groups}"]`);
    await app.waitForText(en.entities.empty.groups.title);
    assert.ok(await app.visibleTextIncludes(en.entities.empty.groups.body));
    await app.clickTextIn(emptyState("groups"), en.groupManagement.newGroup, {
      roles: ["button"],
    });
    await app.waitForText(en.groups.createTitle);
    await app.fillSelector("#group-name", "Empty state group");
    await app.clickTextIn('[role="dialog"]', en.common.buttons.create, {
      roles: ["button"],
    });
    await app.waitFor(
      async () => (await tableRows(app, "groups")).length === 1,
      { description: "the first group replaces the empty state" },
    );
    assert.equal(
      await app.execute("return document.querySelector(arguments[0]);", [
        emptyState("groups"),
      ]),
      null,
    );

    await app.clickSelector(`[aria-label="${en.rail.network}"]`);
    await app.waitForText(en.entities.empty.proxies.title);
    await app.clickTextIn(
      emptyState("proxies"),
      en.proxies.management.newProxy,
      { roles: ["button"] },
    );
    await app.waitFor(
      () =>
        app.execute(`return Boolean(document.querySelector("#proxy-name"));`),
      { description: "the proxy form from the empty state" },
    );
    await dismissSurface(app);
    await app.waitFor(
      async () =>
        !(await app.execute(
          `return Boolean(document.querySelector("#proxy-name"));`,
        )),
      { description: "the proxy form to close" },
    );
    await app.clickText(en.proxies.management.tabVpns, {
      roles: ["tab"],
      exact: false,
    });
    await app.waitForText(en.entities.empty.vpns.title);
    await app.clickText(en.proxies.management.tabProxies, {
      roles: ["tab"],
      exact: false,
    });

    const plain = await app.invoke("create_stored_proxy", {
      name: "Badge HTTP",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 9,
        username: null,
        password: null,
      },
    });
    await app.invoke("create_stored_proxy", {
      name: "Badge Shadowsocks",
      proxySettings: {
        proxy_type: "ss",
        host: "127.0.0.1",
        port: 8388,
        username: "aes-256-gcm",
        password: "badge-secret",
      },
    });
    await app.waitFor(
      async () => (await tableRows(app, "proxies")).length === 2,
      { description: "the proxies replace the empty state" },
    );

    // A protocol is a fact, not a state: an unencrypted first hop keeps the
    // same quiet badge as an encrypted one, and neither is warning-coloured.
    const tokens = await themeTokenColors(app);
    const badges = await app.execute(
      `return [...document.querySelectorAll('[data-table-id="proxies"] [data-slot="kind-badge"]')]
         .map((badge) => ({
           text: badge.innerText.trim(),
           hop: badge.dataset.firstHop,
           color: getComputedStyle(badge).color,
         }));`,
    );
    assert.deepEqual(badges.map((badge) => badge.hop).sort(), [
      "encrypted",
      "plaintext",
    ]);
    for (const badge of badges) {
      assert.equal(badge.color, tokens.muted, `${badge.text} badge colour`);
      assert.notEqual(badge.color, tokens.warning, `${badge.text} badge`);
      assert.notEqual(badge.color, tokens.warningText, `${badge.text} badge`);
    }

    // Row actions wait for hover or focus, and the keyboard reaches them:
    // End moves to the actions cell, F2 enters it. The driver's key events
    // are synthetic, so Enter cannot press a native button, and the headless
    // window never has focus, so focus styles never apply: the test checks
    // focus, then presses the focused action.
    await app.execute(`document.querySelector(arguments[0]).focus();`, [
      `[data-table-id="proxies"] tr[data-table-row="${plain.id}"] [data-table-column="name"]`,
    ]);
    await app.pressShortcut({ key: "\uE010" });
    await app.waitFor(
      () =>
        app.execute(
          `return document.activeElement?.dataset?.tableColumn === "actions";`,
        ),
      { description: "the actions cell to take focus" },
    );
    await app.pressShortcut({ key: "\uE032" });
    await app.waitFor(
      async () =>
        (await app.execute(
          `const active = document.activeElement;
           return active?.matches('[data-slot="row-actions"] button')
             ? active.getAttribute("aria-label")
             : null;`,
        )) ===
        en.tables.rowAction
          .replace("{{action}}", en.proxies.management.editProxy)
          .replace("{{name}}", plain.name),
      { description: "the edit action focused" },
    );
    await app.execute(`document.activeElement.click();`);
    await app.waitFor(
      async () =>
        (await app.execute(
          `return document.querySelector("#proxy-name")?.value ?? null;`,
        )) === plain.name,
      { description: "the edit form opened from the keyboard" },
    );
    await dismissSurface(app);

    await app.invoke("create_vpn_config_manual", {
      name: "Badge VPN",
      vpnType: "WireGuard",
      configData: wireGuardFixture(),
    });
    // The VPN form announces the change itself; the command does not.
    await app.invoke("plugin:event|emit", {
      event: "vpn-configs-changed",
      payload: null,
    });
    await app.clickText(en.proxies.management.tabVpns, {
      roles: ["tab"],
      exact: false,
    });
    await app.waitFor(async () => (await tableRows(app, "vpns")).length === 1, {
      description: "the VPN replaces the empty state",
    });
    assert.equal(
      await app.execute(
        `return getComputedStyle(document.querySelector('[data-table-id="vpns"] [data-slot="kind-badge"]')).color;`,
      ),
      tokens.muted,
    );
  });
});

test("a checked proxy shows its UDP verdict in the table and its check trail in the details", async () => {
  await withApp("ui-proxy-check-trail", async (app) => {
    const proxy = await app.invoke("create_stored_proxy", {
      name: "Trail HTTP Proxy",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        // Discard port: the check fails fast, which is a real check outcome
        // and exactly what the trail has to be able to show.
        port: 9,
        username: null,
        password: null,
      },
    });
    await app.invokeError("check_proxy_validity", {
      proxyId: proxy.id,
      proxySettings: null,
    });

    await app.clickSelector('[aria-label="Network"]');
    await app.waitForText(proxy.name);

    // An HTTP proxy cannot carry a datagram, so the table says so without
    // anyone opening anything.
    await app.waitFor(
      async () =>
        (await app.execute(
          `return document.querySelector('[data-slot="proxy-udp-verdict"]')?.dataset?.udp ?? null;`,
        )) === "no",
      { description: "the UDP verdict cell" },
    );
    assert.equal(
      (
        await app.execute(
          `return document.querySelector('[data-slot="proxy-udp-verdict"]').innerText.trim();`,
        )
      ).toLowerCase(),
      en.proxyCheck.udpNo.toLowerCase(),
    );
    // A proxy without UDP is a property, not a fault, so it is not painted
    // as a warning.
    const udpTokens = await themeTokenColors(app);
    const udpColor = await app.execute(
      `return getComputedStyle(document.querySelector('[data-slot="proxy-udp-verdict"]')).color;`,
    );
    assert.notEqual(udpColor, udpTokens.warning);
    assert.notEqual(udpColor, udpTokens.warningText);
    // The status pill states the failed check in words, beside the flag slot.
    assert.equal(
      await app.execute(
        `return document.querySelector('[data-table-id="proxies"] [data-slot="check-pill"]')?.dataset?.checkState ?? null;`,
      ),
      "failed",
    );

    await app.clickSelector(`[aria-label="${en.appFeedback.routeDetails}"]`);
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector('[data-slot="proxy-check-history"]'));`,
        ),
      { description: "the check trail" },
    );
    await app.waitFor(
      async () =>
        (await app.execute(
          `return document.querySelectorAll('[data-slot="proxy-check-history-entry"]').length;`,
        )) >= 1,
      { description: "at least one remembered check" },
    );

    const trail = await app.execute(
      `return [...document.querySelectorAll('[data-slot="proxy-check-history-entry"]')]
         .map((entry) => entry.innerText.replace(/\\s+/g, " ").trim());`,
    );
    assert.ok(trail.length >= 1);
    assert.ok(
      trail[0].includes(en.proxyCheck.historyFailed),
      `the newest line has to report the failure, got: ${trail[0]}`,
    );
    assert.ok(
      await app.visibleTextIncludes(en.proxyCheck.historyTitle),
      "the trail needs a heading that says what it is",
    );
  });
});

/**
 * Answer one Tauri command from inside the webview.
 *
 * Same seam as {@link stubFolderPicker}: the synchroniser panel needs a live
 * session to control, and a real one launches browsers. Every other command
 * still reaches the real backend, so the panel is exercised as it ships.
 */
async function stubCommand(app, command, reply) {
  await app.execute(
    `const wanted = arguments[0];
     const reply = arguments[1];
     if (!window.__donutOriginalFetch) {
       window.__donutOriginalFetch = window.fetch;
     }
     window.__donutStubbedCalls = window.__donutStubbedCalls ?? [];
     window.__donutStubs = window.__donutStubs ?? {};
     window.__donutStubs[wanted] = reply;
     if (!window.__donutStubInstalled) {
       window.__donutStubInstalled = true;
       window.fetch = function (input, init) {
         const url = String(
           typeof input === "string" ? input : (input && input.url) || "",
         );
         let name = "";
         try {
           name = decodeURIComponent(url.split("/").pop() || "");
         } catch (_error) {
           name = "";
         }
         if (window.__donutStubs[name] !== undefined) {
           let payload = null;
           try {
             payload = JSON.parse((init && init.body) || "null");
           } catch (_error) {
             payload = null;
           }
           window.__donutStubbedCalls.push({ command: name, payload });
           return Promise.resolve(
             new Response(JSON.stringify(window.__donutStubs[name]), {
               status: 200,
               headers: {
                 "content-type": "application/json",
                 "Tauri-Response": "ok",
               },
             }),
           );
         }
         return window.__donutOriginalFetch.apply(window, arguments);
       };
     }
     return true;`,
    [command, reply],
  );
}

async function restoreStubs(app) {
  return app.execute(
    `const calls = window.__donutStubbedCalls ?? [];
     if (window.__donutOriginalFetch) {
       window.fetch = window.__donutOriginalFetch;
       delete window.__donutOriginalFetch;
     }
     delete window.__donutStubbedCalls;
     delete window.__donutStubs;
     delete window.__donutStubInstalled;
     return calls;`,
  );
}

const SYNC = en.profiles.synchronizer;

test("the synchroniser panel lists a live session and its controls act on the real state", async () => {
  await withApp("ui-synchronizer-panel", async (app) => {
    const session = {
      id: "ui-panel-session",
      leader_profile_id: "leader-id",
      leader_profile_name: "Panel leader",
      paused: false,
      followers: [
        {
          profile_id: "follower-one",
          profile_name: "Panel follower one",
          failed_at_url: null,
          held: false,
        },
        {
          profile_id: "follower-two",
          profile_name: "Panel follower two",
          failed_at_url: "https://example.invalid/lost",
          held: false,
        },
      ],
    };
    const panel = '[data-slot="synchronizer-panel"]';
    const followerState = (id) =>
      app.execute(
        `const row = document.querySelector('[data-slot="synchronizer-panel-follower"][data-profile-id="' + arguments[0] + '"]');
         if (!row) return null;
         return {
           held: row.dataset.held === "true",
           badge: row.querySelector('[data-slot="synchronizer-panel-follower-state"]')?.innerText?.trim() ?? null,
           holdLabel: row.querySelector('[data-slot="synchronizer-panel-hold"]')?.innerText?.trim() ?? null,
         };`,
        [id],
      );

    try {
      // The profiles page has to be mounted before any of this means
      // anything: an event emitted before the hook subscribes is simply gone.
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector('[data-slot="profile-workspace"]'));`,
          ),
        { description: "the profiles page" },
      );
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector(arguments[0]));`,
          [panel],
        ),
        false,
        "no session, no panel",
      );

      // Re-emitted until it lands, because subscribing is asynchronous and a
      // missed event is indistinguishable from a broken panel.
      await app.waitFor(
        async () => {
          await app.invoke("plugin:event|emit", {
            event: "sync-session-changed",
            payload: session,
          });
          return app.execute(
            `return Boolean(document.querySelector(arguments[0]));`,
            [panel],
          );
        },
        { description: "the session panel" },
      );

      assert.equal(
        await app.execute(
          `return document.querySelector('[data-slot="synchronizer-panel-leader"]').innerText.trim();`,
        ),
        session.leader_profile_name,
      );
      assert.deepEqual(
        await app.execute(
          `return [...document.querySelectorAll('[data-slot="synchronizer-panel-follower"]')]
             .map((row) => row.dataset.profileId);`,
        ),
        ["follower-one", "follower-two"],
        "followers stay in the order they were chosen",
      );
      assert.deepEqual(await followerState("follower-one"), {
        held: false,
        badge: SYNC.stateMirroring,
        holdLabel: SYNC.holdOut,
      });
      // The desynced follower reports the failure instead of a state badge.
      assert.equal(await app.visibleTextIncludes(SYNC.stateDesynced), true);
      await app.capture("synchronizer-panel");

      // The backend has no such session, so pausing must fail and the panel
      // must keep telling the truth rather than flipping hopefully.
      await app.clickSelector('[data-slot="synchronizer-panel-pause"]');
      await app.waitFor(
        () => app.visibleTextIncludes(en.backendErrors.syncSessionNotFound),
        { description: "the refusal surfaced to the user" },
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('[data-slot="synchronizer-panel-pause"]').innerText.trim();`,
        ),
        SYNC.pauseMirroring,
        "a refused pause must not read as paused",
      );
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('[data-slot="synchronizer-panel-paused-note"]'));`,
        ),
        false,
      );

      // With the backend agreeing, the same click has to land.
      await stubCommand(app, "set_sync_session_paused", {
        ...session,
        paused: true,
      });
      await app.clickSelector('[data-slot="synchronizer-panel-pause"]');
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector('[data-slot="synchronizer-panel-paused-note"]'));`,
          ),
        { description: "the paused state" },
      );
      assert.equal(
        await app.execute(
          `return document.querySelector('[data-slot="synchronizer-panel-pause"]').innerText.trim();`,
        ),
        SYNC.resumeMirroring,
      );
      assert.equal(
        (await followerState("follower-one")).badge,
        SYNC.statePaused,
      );
      await app.capture("synchronizer-panel-paused");

      // Holding one follower out leaves the other exactly as it was.
      await stubCommand(app, "set_sync_follower_held", {
        ...session,
        followers: [
          { ...session.followers[0], held: true },
          session.followers[1],
        ],
      });
      await app.clickSelector(
        '[data-slot="synchronizer-panel-follower"][data-profile-id="follower-one"] [data-slot="synchronizer-panel-hold"]',
      );
      await app.waitFor(
        async () => (await followerState("follower-one")).held === true,
        { description: "the held-out follower" },
      );
      assert.deepEqual(await followerState("follower-one"), {
        held: true,
        badge: SYNC.stateHeld,
        holdLabel: SYNC.rejoin,
      });

      // The layout the user picked is the layout the backend is asked for.
      await stubCommand(app, "arrange_sync_windows", session);
      await app.clickSelector('[data-slot="synchronizer-panel-layout"]');
      await app.clickText(SYNC.layout.cascade, {
        roles: ["option", "menuitem", "button"],
      });
      await app.waitFor(
        async () =>
          (await app.execute(
            `return document.querySelector('[data-slot="synchronizer-panel-layout"]').innerText.trim();`,
          )) === SYNC.layout.cascade,
        { description: "the chosen layout" },
      );
      await app.clickSelector('[data-slot="synchronizer-panel-arrange"]');
      await app.waitFor(
        async () =>
          (await app.execute(
            `return (window.__donutStubbedCalls ?? []).filter((call) => call.command === "arrange_sync_windows").length;`,
          )) === 1,
        { description: "the arrange request" },
      );
      const calls = await app.execute(
        `return window.__donutStubbedCalls.map((call) => call.command + ":" + JSON.stringify(call.payload));`,
      );
      const arrange = calls.find((call) =>
        call.startsWith("arrange_sync_windows"),
      );
      assert.match(arrange, /"layout":"cascade"/);
      assert.match(arrange, /"sessionId":"ui-panel-session"/);
      await app.capture("synchronizer-panel-arranged");

      await app.waitFor(
        async () => {
          await app.invoke("plugin:event|emit", {
            event: "sync-session-ended",
            payload: session.id,
          });
          return (
            (await app.execute(
              `return Boolean(document.querySelector(arguments[0]));`,
              [panel],
            )) === false
          );
        },
        { description: "the panel leaving with the session" },
      );
    } finally {
      await restoreStubs(app);
    }
  });
});

const TIPS_DIALOG = '[data-slot="tips-dialog"]';

async function openTipsFromRail(app) {
  await app.clickSelector('[aria-label="More"]');
  await app.waitFor(
    () =>
      app.execute(`return Boolean(document.querySelector("[role='menu']"));`),
    { description: "More menu" },
  );
  await app.clickSelector('[data-slot="rail-open-tips"]');
  await app.waitFor(
    () =>
      app.execute(`return Boolean(document.querySelector(arguments[0]));`, [
        TIPS_DIALOG,
      ]),
    { description: "the tips catalog" },
  );
}

const COACH_MARK = '[data-slot="tip-coach-mark"]';

/** The tip the coach mark shows, once it is placed and visible. */
async function coachMarkTipId(app) {
  return app.execute(
    `const card = document.querySelector(arguments[0]);
     if (!card || card.dataset.state !== "shown") return null;
     const shell = card.parentElement;
     return getComputedStyle(shell).visibility === "visible" ? card.dataset.tipId : null;`,
    [COACH_MARK],
  );
}

async function waitForCoachMark(app, id) {
  await app.waitFor(async () => (await coachMarkTipId(app)) === id, {
    description: `the ${id} coach mark`,
    timeoutMs: 30_000,
  });
}

async function waitForNoCoachMark(app) {
  await app.waitFor(
    () =>
      app.execute(`return !document.querySelector(arguments[0]);`, [
        COACH_MARK,
      ]),
    { description: "the coach mark gone" },
  );
}

/**
 * Where the coach mark points: its anchor id, the anchor's box, the card's
 * box, the side the card took, and whether the anchor is described by it.
 */
async function coachMarkGeometry(app) {
  return app.execute(
    `const card = document.querySelector(arguments[0]);
     if (!card) return null;
     const id = card.dataset.anchor;
     const anchor = [...document.querySelectorAll('[data-tip-anchor="' + id + '"]')]
       .find((node) => (node.getAttribute("aria-describedby") ?? "").split(" ").includes(card.getAttribute("aria-describedby")));
     const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
     return {
       anchor: id,
       side: card.dataset.side ?? null,
       described: Boolean(anchor),
       anchorBox: anchor ? box(anchor) : null,
       cardBox: box(card),
       beacon: Boolean(document.querySelector('[data-slot="coach-mark-beacon"]')),
       viewport: { width: innerWidth, height: innerHeight },
     };`,
    [COACH_MARK],
  );
}

test("tips open from the rail, walk the catalog, and deep-link into the feature", async () => {
  await withApp("ui-tips-browse", async (app) => {
    await openTipsFromRail(app);
    assert.ok(
      await app.visibleTextIncludes(en.tips.items.commandPalette.title),
    );

    // Every essential is listed, in its section; a plan tip needs a plan,
    // and there is none.
    const listed = await app.execute(
      `return [...document.querySelectorAll('[data-slot="tips-list-item"]')].map((node) => node.dataset.tipId);`,
    );
    for (const id of ["dnsBlocklist", "trash", "vpn", "searchSyntax", "totp"]) {
      assert.ok(listed.includes(id), `${id} is listed`);
    }
    assert.ok(!listed.includes("cookieBot"));
    assert.ok(!listed.includes("synchronizer"));
    assert.ok(!listed.includes("team"));
    assert.equal(
      await app.execute(
        `return document.querySelectorAll('[data-slot="tips-section"]').length;`,
      ),
      4,
      "four sections, and no plan section without a plan",
    );
    assert.equal(
      await app.execute(`return document.activeElement?.dataset.slot;`),
      "tip-advance",
      "Enter walks on from the first moment",
    );

    // The drawing is live SVG in the scene panel, not a picture.
    assert.equal(
      await app.execute(
        `return document.querySelectorAll('[data-slot="tip-scene-panel"] svg[data-slot="tip-scene"]').length;`,
      ),
      1,
    );

    await app.clickSelector('[data-slot="tip-next"]');
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector('[data-slot="tip-detail"]')?.dataset.tipId === "searchSyntax";`,
        ),
      { description: "the second tip" },
    );
    assert.ok(await app.visibleTextIncludes(en.tips.items.searchSyntax.title));

    // Picking from the catalog moves the sliding indicator onto that entry.
    await app.clickSelector(
      '[data-slot="tips-list-item"][data-tip-id="trash"]',
    );
    await app.waitFor(
      () =>
        app.execute(
          `return Boolean(document.querySelector('[data-slot="tips-list-item"][data-tip-id="trash"] [data-slot="tips-list-indicator"]'));`,
        ),
      { description: "the indicator on the chosen tip" },
    );
    assert.ok(await app.visibleTextIncludes(en.tips.items.trash.title));
    assert.equal(
      await app.execute(
        `return document.querySelectorAll('[data-slot="tips-list-indicator"]').length;`,
      ),
      1,
      "exactly one entry is marked current",
    );
    await app.capture("tips-browse");

    // The arrows page through the catalog from the keyboard.
    await app.pressShortcut({ key: "ArrowRight" });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector('[data-slot="tip-detail"]')?.dataset.tipId === "selfHostedSync";`,
        ),
      { description: "the tip after the trash tip" },
    );
    await app.pressShortcut({ key: "ArrowLeft" });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector('[data-slot="tip-detail"]')?.dataset.tipId === "trash";`,
        ),
      { description: "back to the trash tip" },
    );

    // Read tips are remembered, so the inline tip never repeats them, and
    // the catalog marks only the unread ones.
    await app.waitFor(
      async () => {
        const state = await app.invoke("get_tips_state");
        return ["commandPalette", "searchSyntax", "trash"].every((id) =>
          state.seen.includes(id),
        );
      },
      { description: "seen tips persisted" },
    );
    assert.deepEqual(
      await app.execute(
        `return ["commandPalette", "vpn"].map((id) => Boolean(document.querySelector('[data-slot="tips-list-item"][data-tip-id="' + id + '"] [data-slot="tips-unread-dot"]')));`,
      ),
      [false, true],
    );

    // The action lands inside the feature: the DNS tip opens settings on
    // its DNS section, and the dialog leaves after its short exit.
    await app.clickSelector(
      '[data-slot="tips-list-item"][data-tip-id="dnsBlocklist"]',
    );
    await app.clickSelector('[data-slot="tip-action"]');
    await app.waitFor(
      () =>
        app.execute(
          `return document.activeElement?.dataset?.settingsSection === "dns";`,
        ),
      { description: "the DNS settings section focused" },
    );
    await app.waitFor(
      () =>
        app.execute(`return !document.querySelector(arguments[0]);`, [
          TIPS_DIALOG,
        ]),
      { timeoutMs: 2000, description: "the tips dialog to leave" },
    );

    // The chord opens the catalog too, and the switch turns the automatic
    // flow off and persists that.
    await app.pressShortcut({
      ...(process.platform === "darwin" ? { meta: true } : { ctrl: true }),
      shift: true,
      key: "h",
    });
    await app.waitFor(
      () =>
        app.execute(`return Boolean(document.querySelector(arguments[0]));`, [
          TIPS_DIALOG,
        ]),
      { description: "the tips catalog from the keyboard" },
    );
    assert.equal(
      await app.execute(
        `return document.querySelector('[data-slot="tips-auto-show"]').getAttribute("data-state");`,
      ),
      "unchecked",
      "the harness seeds the automatic flow off",
    );
    await app.clickSelector('[data-slot="tips-auto-show"]');
    await app.waitFor(
      async () => (await app.invoke("get_tips_state")).auto_show === true,
      { description: "the preference persisted" },
    );
    await dismissSurface(app);
    await app.waitFor(
      () =>
        app.execute(`return !document.querySelector(arguments[0]);`, [
          TIPS_DIALOG,
        ]),
      { description: "the dialog closed" },
    );
  });
});

test("one tip a day points at an unused feature on the Profiles page, and a dismissed one waits for tomorrow", async () => {
  // Every tip but two is read already, and the only profile blocks ads, so
  // the DNS tip is in use and the trash tip is the one the page may show.
  // Tips are switched on only after that profile exists.
  const unseen = ["dnsBlocklist", "trash"];
  const seen = Object.keys(en.tips.items).filter((id) => !unseen.includes(id));
  await withApp(
    "ui-tips-inline",
    async (app) => {
      const profile = await createUiProfile(app, "Tips Blocker");
      await app.invoke("update_profile_dns_blocklist", {
        profileId: profile.id,
        dnsBlocklist: "light",
      });
      await app.invoke("set_tips_auto_show", { enabled: true });
      await app.restart();

      await waitForCoachMark(app, "trash");
      assert.ok(await app.visibleTextIncludes(en.tips.items.trash.title));
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));`,
        ),
        false,
        "the tip is a coach mark on the page, not a dialog",
      );
      assert.equal(
        await app.execute(
          `return document.querySelector(arguments[0]).contains(document.activeElement);`,
          [COACH_MARK],
        ),
        false,
        "the tip never takes the focus",
      );
      // The trash lives in the rail's More menu, so the mark points at the
      // More button, with its card to the right of the rail.
      const geometry = await coachMarkGeometry(app);
      assert.equal(geometry.anchor, "rail-more");
      assert.equal(geometry.side, "right");
      assert.ok(geometry.described, "the anchor is described by the tip");
      assert.ok(geometry.beacon, "a beacon marks the feature");
      assert.ok(
        geometry.cardBox.left >= geometry.anchorBox.right,
        `the card sits beside its anchor: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.cardBox.top >= 0 &&
          geometry.cardBox.bottom <= geometry.viewport.height,
        "the card stays on screen",
      );
      const pinned = await app.invoke("get_tips_state");
      assert.equal(pinned.inline_tip, "trash");
      assert.equal(pinned.auto_due, false);
      assert.ok(
        !pinned.seen.includes("trash") && !pinned.seen.includes("dnsBlocklist"),
        "showing a tip is not reading it, and the skipped tip stays unread",
      );
      await app.capture("tips-coach-mark");

      // The day's tip comes back after a restart until it is closed.
      await app.restart();
      await waitForCoachMark(app, "trash");

      await app.clickSelector('[data-slot="tip-coach-dismiss"]');
      await waitForNoCoachMark(app);
      const state = await app.waitFor(
        async () => {
          const current = await app.invoke("get_tips_state");
          return current.seen.includes("trash") ? current : null;
        },
        { description: "the dismissed tip recorded" },
      );
      assert.equal(state.inline_tip, null);
      assert.equal(state.auto_due, false);
      const wait = state.next_auto_show_at - Math.floor(Date.now() / 1000);
      assert.ok(
        wait >= 12 * 60 * 60 - 60 && wait <= 24 * 60 * 60,
        `the next tip waits for the next day, not ${wait} seconds`,
      );

      // A restart the same day shows nothing, and keeps the same wait.
      await app.restart();
      await app.waitForText("Tips Blocker");
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector(arguments[0]));`,
          [COACH_MARK],
        ),
        false,
      );
      assert.equal(
        (await app.invoke("get_tips_state")).next_auto_show_at,
        state.next_auto_show_at,
      );
    },
    { settings: { tips_seen: seen } },
  );
});

/** Settings where only `id` is unread, and it is the tip on the page. */
function pinnedTip(id) {
  return {
    tips_seen: Object.keys(en.tips.items).filter((other) => other !== id),
    tips_auto_show: true,
    tips_inline: id,
  };
}

test("the coach mark's action opens its feature and closes the tip as read", async () => {
  await withApp(
    "ui-tips-inline-action",
    async (app) => {
      await createUiProfile(app, "Tips Action");
      await app.waitForText("Tips Action");
      await waitForCoachMark(app, "trash");
      assert.ok(await app.visibleTextIncludes(en.tips.items.trash.title));

      await app.clickSelector('[data-slot="tip-coach-action"]');
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector('[data-slot="trash-page"]'));`,
          ),
        { description: "the trash page" },
      );
      const done = await app.waitFor(
        async () => {
          const current = await app.invoke("get_tips_state");
          return current.seen.includes("trash") ? current : null;
        },
        { description: "the acted-on tip recorded" },
      );
      assert.equal(done.inline_tip, null);
      assert.equal(done.auto_due, false);
    },
    { settings: pinnedTip("trash") },
  );
});

test("turning tips off from the coach mark takes it away, unread, for the day", async () => {
  await withApp(
    "ui-tips-inline-off",
    async (app) => {
      await createUiProfile(app, "Tips Off");
      await app.waitForText("Tips Off");
      await waitForCoachMark(app, "vpn");
      assert.equal((await coachMarkGeometry(app)).anchor, "rail-proxies");

      await app.clickSelector('[data-slot="tip-coach-menu"]');
      await app.clickSelector('[data-slot="tip-coach-off"]');
      await waitForNoCoachMark(app);
      assert.ok(await app.visibleTextIncludes(en.tips.coach.offTitle));
      const off = await app.invoke("get_tips_state");
      assert.equal(off.auto_show, false);
      assert.equal(off.inline_tip, null);
      assert.ok(!off.seen.includes("vpn"), "turned off is not read");
      const wait = off.next_auto_show_at - Math.floor(Date.now() / 1000);
      assert.ok(
        wait >= 12 * 60 * 60 - 60 && wait <= 24 * 60 * 60,
        `the removed tip counts as the day's tip, not ${wait} seconds`,
      );

      // Back on from the catalog, nothing new appears the same day.
      await app.pressShortcut({
        ...(process.platform === "darwin" ? { meta: true } : { ctrl: true }),
        shift: true,
        key: "h",
      });
      await app.waitFor(
        () =>
          app.execute(`return Boolean(document.querySelector(arguments[0]));`, [
            TIPS_DIALOG,
          ]),
        { description: "the tips catalog" },
      );
      await app.clickSelector('[data-slot="tips-auto-show"]');
      await app.waitFor(
        async () => (await app.invoke("get_tips_state")).auto_show === true,
        { description: "tips back on" },
      );
      await dismissSurface(app);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector(arguments[0]));`,
          [COACH_MARK],
        ),
        false,
      );
      assert.equal((await app.invoke("get_tips_state")).auto_due, false);
    },
    { settings: pinnedTip("vpn") },
  );
});

test("a tip for a feature on the page points at it, and using the feature or Escape closes it as read", async () => {
  await withApp(
    "ui-tips-coach-anchor",
    async (app) => {
      await createUiProfile(app, "Tips Anchor");
      await app.waitForText("Tips Anchor");
      await waitForCoachMark(app, "dnsBlocklist");
      // DNS blocking is a column on this page: the mark points at its header,
      // under it, and the action still goes to the DNS settings.
      const geometry = await coachMarkGeometry(app);
      assert.equal(geometry.anchor, "column-dns");
      assert.equal(geometry.side, "bottom");
      assert.ok(geometry.cardBox.top >= geometry.anchorBox.bottom);
      assert.ok(
        await app.execute(
          `return Boolean(document.querySelector('[data-slot="tip-coach-action"]'));`,
        ),
      );
      await app.capture("tips-coach-mark-column");

      // It follows its anchor: a narrower window moves the card with it.
      const before = geometry.cardBox.left;
      const rect = await app.session.command("GET", "/window/rect");
      await app.session.command("POST", "/window/rect", {
        width: rect.width + 120,
        height: rect.height,
      });
      await app.waitFor(
        async () => {
          const moved = await coachMarkGeometry(app);
          return (
            moved?.anchor === "column-dns" &&
            Math.abs(moved.cardBox.left - before) > 4 &&
            moved.cardBox.top >= moved.anchorBox.bottom
          );
        },
        { description: "the card following its anchor" },
      );
      await app.session.command("POST", "/window/rect", rect);

      // Escape closes it as read, like Got it.
      await app.pressShortcut({ key: "Escape" });
      await waitForNoCoachMark(app);
      const closed = await app.waitFor(
        async () => {
          const current = await app.invoke("get_tips_state");
          return current.seen.includes("dnsBlocklist") ? current : null;
        },
        { description: "the tip closed by Escape recorded" },
      );
      assert.equal(closed.inline_tip, null);
    },
    { settings: pinnedTip("dnsBlocklist") },
  );
});

test("clicking the feature a coach mark points at closes the tip as read", async () => {
  await withApp(
    "ui-tips-coach-activate",
    async (app) => {
      await createUiProfile(app, "Tips Activate");
      await app.waitForText("Tips Activate");
      await waitForCoachMark(app, "searchSyntax");
      assert.equal((await coachMarkGeometry(app)).anchor, "profile-search");
      await app.clickSelector('[data-tip-anchor="profile-search"] input');
      await waitForNoCoachMark(app);
      await app.waitFor(
        async () =>
          (await app.invoke("get_tips_state")).seen.includes("searchSyntax"),
        { description: "the used feature closes its tip as read" },
      );
    },
    { settings: pinnedTip("searchSyntax") },
  );
});

const PROFILE_SCROLL = '[data-table-id="profiles"] .scroll-fade';

/**
 * The coach mark on the profile table: whether it shows, the anchor it
 * describes (with its row), its ring, its card and the table's scroll box.
 */
async function tableCoachMark(app) {
  return app.execute(
    `const card = document.querySelector(arguments[0]);
     const scroll = document.querySelector(arguments[1]);
     if (!card || !scroll) return null;
     const body = card.getAttribute("aria-describedby");
     const anchor = [...document.querySelectorAll("[data-tip-anchor]")]
       .find((node) => (node.getAttribute("aria-describedby") ?? "").split(" ").includes(body));
     const ring = document.querySelector('[data-slot="coach-mark-ring"] rect');
     const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
     return {
       shown: card.dataset.state === "shown" &&
         getComputedStyle(card.parentElement).visibility === "visible",
       anchor: card.dataset.anchor,
       profileId: anchor?.dataset.profileId ?? null,
       anchorBox: anchor ? box(anchor) : null,
       ringBox: ring ? box(ring) : null,
       cardBox: box(card),
       tableBox: box(scroll),
       firstRow: scroll.querySelector("tr[data-table-row]")?.dataset.tableRow ?? null,
     };`,
    [COACH_MARK, PROFILE_SCROLL],
  );
}

/** The ring sits 4px around the anchor it describes, and the card is beside it. */
function markHugsAnchor(mark) {
  if (!mark?.shown || !mark.anchorBox || !mark.ringBox) return false;
  const near = (a, b) => Math.abs(a - b) <= 3;
  const { anchorBox: anchor, ringBox: ring, cardBox: card } = mark;
  const covers =
    card.left < anchor.right &&
    anchor.left < card.right &&
    card.top < anchor.bottom &&
    anchor.top < card.bottom;
  return (
    near(ring.left, anchor.left - 4) &&
    near(ring.top, anchor.top - 4) &&
    near(ring.right, anchor.right + 4) &&
    near(ring.bottom, anchor.bottom + 4) &&
    !covers
  );
}

/** A row's info button below the sticky header, inside the table's box. */
function rowInView(mark) {
  return (
    mark.anchor === "row-inspect" &&
    mark.anchorBox.top >= mark.tableBox.top + 32 &&
    mark.anchorBox.bottom <= mark.tableBox.bottom
  );
}

async function scrollProfileTable(app, top) {
  await app.execute(
    `const scroll = document.querySelector(arguments[0]);
     scroll.scrollTop = arguments[1] === "end" ? scroll.scrollHeight : arguments[1];`,
    [PROFILE_SCROLL, top],
  );
}

test("a coach mark on a table row follows the scroll and moves to a row in view when its row leaves", async () => {
  await withApp(
    "ui-tips-coach-scroll",
    async (app) => {
      for (let i = 0; i < 30; i++)
        await createUiProfile(app, `Scroll ${String(i + 1).padStart(2, "0")}`);
      // A fresh start puts the table at its top and the mark on no row yet.
      await app.restart();
      await app.session.command("POST", "/window/rect", {
        width: 1280,
        height: 720,
      });
      await app.waitFor(
        () =>
          app.execute(
            `const scroll = document.querySelector(arguments[0]);
             return scroll?.querySelector("table")?.getAttribute("aria-rowcount") === "31" &&
               scroll.scrollTop === 0 &&
               scroll.scrollHeight > scroll.clientHeight + 400;`,
            [PROFILE_SCROLL],
          ),
        { description: "thirty rows that scroll" },
      );
      await waitForCoachMark(app, "totp");

      // The 2FA tip points at the first row's info button.
      const first = await app.waitFor(
        async () => {
          const mark = await tableCoachMark(app);
          return markHugsAnchor(mark) && rowInView(mark) ? mark : null;
        },
        { description: "the mark on a row's info button" },
      );
      assert.equal(first.profileId, first.firstRow);

      // Its row scrolls away under the header: the mark moves to a row that
      // shows, and never stays on the empty spot.
      await scrollProfileTable(app, 360);
      const moved = await app.waitFor(
        async () => {
          const mark = await tableCoachMark(app);
          return markHugsAnchor(mark) &&
            rowInView(mark) &&
            mark.profileId !== first.profileId
            ? mark
            : null;
        },
        { description: "the mark on a row still in view" },
      );

      // A short scroll keeps that row in view: the mark follows it.
      await scrollProfileTable(app, 336);
      await app.waitFor(
        async () => {
          const mark = await tableCoachMark(app);
          return (
            markHugsAnchor(mark) &&
            rowInView(mark) &&
            mark.profileId === moved.profileId &&
            Math.abs(mark.anchorBox.top - (moved.anchorBox.top + 24)) <= 2
          );
        },
        { description: "the mark following its row" },
      );

      // To the end and back to the top: each time the followed row leaves,
      // the mark lands on a row in view.
      for (const top of ["end", 0]) {
        const before = (await tableCoachMark(app)).profileId;
        await scrollProfileTable(app, top);
        await app.waitFor(
          async () => {
            const mark = await tableCoachMark(app);
            return (
              markHugsAnchor(mark) &&
              rowInView(mark) &&
              mark.profileId !== before
            );
          },
          { description: `the mark in view after scrolling to ${top}` },
        );
      }
    },
    { settings: pinnedTip("totp") },
  );
});

test("Show me in the catalog points the tip at its feature without spending the day's tip", async () => {
  await withApp("ui-tips-show-me", async (app) => {
    await createUiProfile(app, "Tips Show Me");
    await app.waitForText("Tips Show Me");
    await openTipsFromRail(app);
    await app.clickSelector(
      '[data-slot="tips-list-item"][data-tip-id="proxyCheck"]',
    );
    await app.clickSelector('[data-slot="tip-show-me"]');
    await app.waitFor(
      () =>
        app.execute(`return !document.querySelector(arguments[0]);`, [
          TIPS_DIALOG,
        ]),
      { description: "the catalog closed" },
    );
    await waitForCoachMark(app, "proxyCheck");
    const geometry = await coachMarkGeometry(app);
    assert.equal(geometry.anchor, "column-proxy");
    assert.equal(
      await app.execute(
        `return document.querySelector(arguments[0]).dataset.preview;`,
        [COACH_MARK],
      ),
      "true",
    );
    assert.equal(
      await app.execute(
        `return Boolean(document.querySelector('[data-slot="tip-coach-off"]'));`,
      ),
      false,
      "a tip asked for is not the place to turn tips off",
    );
    const before = await app.invoke("get_tips_state");
    await app.capture("tips-show-me");
    await app.clickSelector('[data-slot="tip-coach-dismiss"]');
    await waitForNoCoachMark(app);
    const after = await app.invoke("get_tips_state");
    assert.equal(after.inline_tip, before.inline_tip);
    assert.equal(after.next_auto_show_at, before.next_auto_show_at);
  });
});

test("a freshly paid account is welcomed once and walked to its plan tips", async () => {
  await withApp("ui-paid-welcome", async (app) => {
    await app.waitForText("No profiles yet");
    try {
      // A pro account that signed in a moment ago, as the desktop would hold
      // it after a device-code login. Only the IPC read of the cached user is
      // stubbed; the plan observation and the tips state run for real.
      await stubCommand(app, "cloud_get_user", {
        logged_in_at: new Date().toISOString(),
        user: {
          id: "ui-paid-welcome",
          email: "paid@example.test",
          plan: "pro",
          planPeriod: "monthly",
          subscriptionStatus: "active",
          profileLimit: 50,
          cloudProfilesUsed: 0,
          proxyBandwidthLimitMb: 0,
          proxyBandwidthUsedMb: 0,
          proxyBandwidthExtraMb: 0,
          isPrimaryDevice: true,
        },
      });
      await app.invoke("plugin:event|emit", {
        event: "cloud-auth-changed",
        payload: null,
      });
      await app.waitFor(
        () =>
          app.execute(
            `return Boolean(document.querySelector('[data-slot="paid-welcome"]'));`,
          ),
        { description: "the paid welcome" },
      );
      assert.ok(
        await app.visibleTextIncludes(
          en.paidWelcome.title.replace("{{plan}}", "Pro"),
        ),
      );
      assert.deepEqual(
        await app.execute(
          `return [...document.querySelectorAll('[data-slot="paid-welcome-item"]')].map((node) => node.dataset.tipId);`,
        ),
        [
          "cloudBackup",
          "cookieBot",
          "crossOs",
          "synchronizer",
          "automation",
          "agent",
          "remoteControl",
        ],
        "every capability the plan grants, in catalog order, and nothing it lacks",
      );
      await app.capture("paid-welcome");

      // A row opens the catalog on that tip, with the plan tips now listed.
      await app.clickSelector(
        '[data-slot="paid-welcome-item"][data-tip-id="cookieBot"]',
      );
      await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector('[data-slot="tip-detail"]')?.dataset.tipId === "cookieBot";`,
          ),
        { description: "the Cookie Bot tip" },
      );
      // The welcome leaves after its short exit, under the catalog.
      await app.waitFor(
        () =>
          app.execute(
            `return !document.querySelector('[data-slot="paid-welcome"]');`,
          ),
        { timeoutMs: 2000, description: "the paid welcome to leave" },
      );
      const listed = await app.execute(
        `return [...document.querySelectorAll('[data-slot="tips-list-item"]')].map((node) => node.dataset.tipId);`,
      );
      assert.ok(listed.includes("cookieBot") && listed.includes("agent"));
      assert.ok(listed.includes("dnsBlocklist"));
      await app.capture("tips-plan-catalog");
      await dismissSurface(app);
      await app.waitFor(
        () =>
          app.execute(`return !document.querySelector(arguments[0]);`, [
            TIPS_DIALOG,
          ]),
        { description: "the catalog closed" },
      );

      // Greeted once: the same account signing in again is not welcomed twice.
      await app.invoke("plugin:event|emit", {
        event: "cloud-auth-changed",
        payload: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('[data-slot="paid-welcome"]'));`,
        ),
        false,
      );
      assert.equal(
        await app.invoke("observe_cloud_plan", {
          userId: "ui-paid-welcome",
          paid: true,
          freshLogin: true,
        }),
        false,
      );
    } finally {
      await restoreStubs(app);
    }
  });
});

test("profile statuses start from a common set and are picked from the table", async () => {
  await withApp("ui-profile-statuses", async (app) => {
    const profile = await createUiProfile(app, "Profile With Status");
    await app.waitForText(profile.name);
    const cell = '[data-slot="profile-status-cell"]';
    const statusOf = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      ).status_id ?? null;

    await app.clickSelector(cell);
    await app.clickText(en.profileStatuses.manage, { roles: ["option"] });
    await app.waitForText(en.profileStatuses.empty);
    await app.capture("profile-statuses-empty");
    await app.clickText(en.profileStatuses.addStarter, { roles: ["button"] });
    await app.waitFor(
      async () => (await app.invoke("list_profile_statuses")).length === 4,
      { description: "the starter statuses" },
    );
    assert.deepEqual(
      (await app.invoke("list_profile_statuses")).map((item) => item.name),
      [
        en.profileStatuses.starter.active,
        en.profileStatuses.starter.warming,
        en.profileStatuses.starter.review,
        en.profileStatuses.starter.banned,
      ],
    );
    await app.capture("profile-statuses-starter");
    await dismissSurface(app);

    await app.clickSelector(cell);
    await app.clickText(en.profileStatuses.starter.banned, {
      exact: false,
      roles: ["option"],
    });
    const banned = (await app.invoke("list_profile_statuses")).find(
      (item) => item.name === en.profileStatuses.starter.banned,
    );
    await app.waitFor(async () => (await statusOf()) === banned.id, {
      description: "the picked status",
    });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector(arguments[0])?.textContent.includes(arguments[1]);`,
          [cell, en.profileStatuses.starter.banned],
        ),
      { description: "the cell shows the status" },
    );
    await app.capture("profile-status-cell");

    await app.clickSelector(cell);
    await app.clickText(en.profileStatuses.none, { roles: ["option"] });
    await app.waitFor(async () => (await statusOf()) === null, {
      description: "the status cleared",
    });
  });
});

test("the start pages section saves one page per line and reports a bad page", async () => {
  await withApp("ui-start-pages", async (app) => {
    const profile = await createUiProfile(app, "Profile Start Pages");
    await app.waitForText(profile.name);
    const stored = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      ).start_urls ?? [];
    await app.clickSelector(
      `[data-slot="profile-inspect-trigger"][data-profile-id="${profile.id}"]`,
    );
    await app.clickSelector(
      '[data-slot="profile-info-section"][data-section="startPages"]',
    );
    await app.waitForText(en.startPages.description);
    const field = '[data-slot="profile-start-pages-input"]';
    await app.fillSelector(field, "mail.example\nfile:///etc/hosts");
    await app.clickText(en.common.buttons.save, { exact: true });
    await app.waitForText(
      en.backendErrors.startUrlInvalid.replace("{{url}}", "file:///etc/hosts"),
    );
    assert.deepEqual(await stored(), []);
    await app.fillSelector(field, "mail.example\nhttps://shop.example/cart");
    await app.clickText(en.common.buttons.save, { exact: true });
    await app.waitFor(
      async () =>
        JSON.stringify(await stored()) ===
        JSON.stringify(["https://mail.example/", "https://shop.example/cart"]),
      { description: "the saved start pages" },
    );
    await app.capture("profile-start-pages");
    await app.clickSelector('[data-slot="profile-info-close"]');
  });
});

test("2FA codes come from a pasted key and from a profile's saved keys", async () => {
  await withApp("ui-two-factor", async (app) => {
    const profile = await createUiProfile(app, "Profile Two Factor");
    await app.waitForText(profile.name);

    await app.pressShortcut({
      key: "o",
      shift: true,
      ...(process.platform === "darwin" ? { meta: true } : { ctrl: true }),
    });
    await app.waitForText(en.totp.toolDescription);
    await app.fillSelector("#totp-tool-key", "JBSWY3DPEHPK3PXP");
    await app.waitFor(
      () =>
        app.execute(
          `return /^\\d{3} \\d{3}$/.test(document.querySelector('[data-slot="totp-tool-dialog"] [data-slot="totp-code"] span')?.textContent ?? "");`,
        ),
      { description: "a code from the pasted key" },
    );
    await app.capture("totp-tool");
    await dismissSurface(app);

    await app.clickSelector(
      `[data-slot="profile-inspect-trigger"][data-profile-id="${profile.id}"]`,
    );
    await app.clickSelector(
      '[data-slot="profile-info-section"][data-section="twoFactor"]',
    );
    await app.waitForText(en.totp.empty);
    await app.fillSelector(
      '[data-slot="profile-totp-key"]',
      "otpauth://totp/Mail:bob?secret=JBSWY3DPEHPK3PXP&issuer=Mail",
    );
    await app.clickText(en.totp.add, { roles: ["button"] });
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelectorAll('[data-slot="profile-totp-entry"] [data-slot="totp-code"]').length === 1;`,
        ),
      { description: "the saved key shows a live code" },
    );
    await app.capture("profile-totp-section");
    assert.equal(
      (await app.invoke("list_profile_totp", { profileId: profile.id }))[0]
        .label,
      "Mail",
    );
    await app.clickSelector('[data-slot="profile-info-close"]');
  });
});

test("the profile network section saves, refuses and clears a DNS server", async () => {
  await withApp("ui-dns-server", async (app) => {
    const profile = await createUiProfile(app, "Profile DNS Server");
    await app.waitForText(profile.name);
    const stored = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      ).dns_server ?? null;
    const field = '[data-slot="dns-server-field"] input';
    const saveEnabled = () =>
      app.execute(
        `return [...document.querySelectorAll('[data-slot="dns-server-field"] button[type="submit"]')].some((button) => !button.disabled);`,
      );

    await app.clickSelector(
      `[data-slot="profile-inspect-trigger"][data-profile-id="${profile.id}"]`,
    );
    await app.clickSelector(
      '[data-slot="profile-info-section"][data-section="network"]',
    );
    await app.waitForText(en.profileInfo.sectionDesc.network);
    await app.waitForText(en.dnsServer.summary.default);

    await app.fillSelector(field, "1.1.1.1");
    await app.waitForText(
      `${en.dnsServer.summary.https.replace("{{server}}", "cloudflare-dns.com")} ${en.dnsServer.summary.upgraded}`,
    );
    await app.capture("profile-dns-server-upgraded");
    await app.clickText(en.common.buttons.save, { exact: true });
    await app.waitFor(async () => (await stored()) === "1.1.1.1", {
      description: "the saved DNS server",
    });
    await app.waitFor(
      () =>
        app.execute(
          `return !document.querySelector('[data-slot="dns-server-field"] button[type="submit"]');`,
        ),
      { description: "nothing left to save" },
    );

    await app.fillSelector(field, "not a server");
    await app.waitForText(en.backendErrors.dnsServerInvalid);
    assert.equal(await saveEnabled(), false);
    assert.equal(await stored(), "1.1.1.1");

    await app.fillSelector(field, "tcp://1.1.1.1");
    await app.waitForText(
      en.dnsServer.summary.tcp.replace("{{server}}", "1.1.1.1"),
    );
    await app.capture("profile-dns-server-plain");
    // Typed away rather than cleared, so the field sees real input events.
    await app.fillSelector(field, "x");
    await app.session.sendKeys(
      await app.execute("return document.querySelector(arguments[0]);", [
        field,
      ]),
      "\uE003",
    );
    await app.waitForText(en.dnsServer.summary.default);
    await app.clickText(en.common.buttons.save, { exact: true });
    await app.waitFor(async () => (await stored()) === null, {
      description: "the cleared DNS server",
    });
    await app.clickSelector('[data-slot="profile-info-close"]');
  });
});

test("a Pro user's fingerprint tab shows the device, and says why when it cannot", async () => {
  await withApp("ui-fingerprint-view", async (app) => {
    const created = await createUiProfile(app, "Identity Device");
    // An identity-backed profile stores the identity, never the device, on a
    // version that reads it from the browser.
    const file = path.join(
      app.dataRoot,
      "data",
      "profiles",
      created.id,
      "metadata.json",
    );
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.version = "154.0.8037.57";
    delete stored.wayfern_config.fingerprint;
    stored.wayfern_config.identity_id = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";
    await writeFile(file, JSON.stringify(stored));
    await app.restart();
    await app.waitForText("Identity Device");
    await stubCommand(app, "cloud_get_user", {
      logged_in_at: "2020-01-01T00:00:00Z",
      user: {
        id: "fingerprint-pro",
        email: "fingerprint@example.test",
        plan: "pro",
        planPeriod: "monthly",
        subscriptionStatus: "active",
        profileLimit: 50,
        isPrimaryDevice: true,
      },
    });
    await app.invoke("plugin:event|emit", {
      event: "cloud-auth-changed",
      payload: null,
    });
    await app.clickSelector(
      `[data-slot="profile-inspect-trigger"][data-profile-id="${created.id}"]`,
    );
    await app.clickSelector(
      '[data-slot="profile-info-section"][data-section="fingerprint"]',
    );

    // This suite has no browser build, so the read fails: the tab says so and
    // keeps the fields shut instead of showing them empty.
    const state = '[data-slot="fingerprint-device-state"]';
    await app.waitFor(
      () =>
        app.execute(
          `return document.querySelector(arguments[0])?.dataset.state === "failed";`,
          [state],
        ),
      { description: "the failed device read is shown" },
    );
    assert.equal(
      await app.execute(
        `return document.querySelector("#user-agent").matches(":disabled");`,
      ),
      true,
    );
    await app.capture("fingerprint-view-failed");

    // A read that works fills the fields with the device the profile presents.
    const device = {
      userAgent: "Mozilla/5.0 (Macintosh) E2E/1.0",
      platform: "MacIntel",
      hardwareConcurrency: 8,
    };
    await stubCommand(app, "get_profile_fingerprint", JSON.stringify(device));
    await app.clickTextIn(state, en.common.buttons.retry, {
      roles: ["button"],
    });
    await app.waitFor(
      () =>
        app.execute(
          `const input = document.querySelector("#user-agent");
           return input && !input.matches(":disabled") && input.value === arguments[0];`,
          [device.userAgent],
        ),
      { description: "the device fills the fingerprint fields" },
    );
    assert.equal(
      await app.execute(
        `return Boolean(document.querySelector(arguments[0]));`,
        [state],
      ),
      false,
    );
    await app.capture("fingerprint-view-shown");
    await restoreStubs(app);
  });
});

test("Pro users can edit and save launch arguments in each profile", async () => {
  await withApp(
    "ui-launch-args",
    async (app) => {
      const profile = await createUiProfile(app, "Profile Launch Arguments");
      await app.waitForText(profile.name);
      const openEditor = async () => {
        await app.clickSelector(
          `[data-slot="profile-inspect-trigger"][data-profile-id="${profile.id}"]`,
        );
        await app.clickSelector(
          '[data-slot="profile-info-section"][data-section="fingerprint"]',
        );
        await app.waitForText(en.fingerprint.launchArgs);
      };
      await openEditor();
      assert.equal(
        await app.execute(
          'return document.querySelector("#wayfern-launch-args").disabled;',
        ),
        true,
      );
      await app.clickSelector('[data-slot="profile-info-close"]');
      try {
        await stubCommand(app, "cloud_get_user", {
          logged_in_at: "2020-01-01T00:00:00Z",
          user: {
            id: "launch-args-pro",
            email: "launch-args@example.test",
            plan: "pro",
            planPeriod: "monthly",
            subscriptionStatus: "active",
            profileLimit: 50,
            isPrimaryDevice: true,
          },
        });
        await app.invoke("plugin:event|emit", {
          event: "cloud-auth-changed",
          payload: null,
        });
        await openEditor();
        await app.waitFor(
          () =>
            app.execute(
              'return !document.querySelector("#wayfern-launch-args").disabled;',
            ),
          { description: "Pro launch arguments editor" },
        );
        const input = "--disable-gpu\n--renderer-process-limit=4";
        await app.fillSelector("#wayfern-launch-args", input);
        assert.equal(
          await app.execute(
            'return document.querySelector("#wayfern-launch-args").value;',
          ),
          input,
        );
        await app.capture("launch-arguments-pro");
        await app.clickText(en.common.buttons.save, { exact: true });
        await app.waitFor(
          async () =>
            (await app.invoke("list_browser_profiles"))[0].wayfern_config
              .launch_args?.length === 2,
          { description: "saved launch arguments" },
        );
        // Saving keeps the panel open, with the saved value in the editor.
        assert.equal(
          await app.execute(
            'return document.querySelector("#wayfern-launch-args").value;',
          ),
          input,
        );
        await app.fillSelector(
          "#wayfern-launch-args",
          "--user-data-dir=/tmp/other",
        );
        await app.clickText(en.common.buttons.save, { exact: true });
        await app.waitForText(
          en.backendErrors.wayfernLaunchArgReserved.replace(
            "{{argument}}",
            "--user-data-dir",
          ),
        );
        assert.deepEqual(
          (await app.invoke("list_browser_profiles"))[0].wayfern_config
            .launch_args,
          input.split("\n"),
        );
        await app.clickSelector('[data-slot="profile-info-close"]');
        // The refused draft is still unsaved, so closing asks first.
        await app.clickSelector('[data-slot="leave-prompt-discard"]');
        await restoreStubs(app);
        await app.invoke("plugin:event|emit", {
          event: "cloud-auth-changed",
          payload: null,
        });
        await openEditor();
        await app.waitFor(
          () =>
            app.execute(
              'return document.querySelector("#wayfern-launch-args").disabled;',
            ),
          { description: "launch arguments locked after sign out" },
        );
        await app.clickText(en.common.buttons.clear, { exact: true });
        await app.clickText(en.common.buttons.save, { exact: true });
        await app.waitFor(
          async () =>
            !(await app.invoke("list_browser_profiles"))[0].wayfern_config
              .launch_args?.length,
          { description: "cleared launch arguments" },
        );
      } finally {
        await restoreStubs(app);
      }
    },
    { extraEnv: { WAYFERN_TEST_TOKEN: "e2e-local-launch-args" } },
  );
});

test("the create dialog warns a free user who creates quickly, holds a capped plan at its hourly limit, and never offers more profiles than fit", async () => {
  await withApp(
    "ui-profile-hourly-limit",
    async (app) => {
      const createDisabled = () =>
        app.execute(
          `const button = document.querySelector('[data-slot="profile-create-submit"]');
         return button ? button.disabled : null;`,
        );
      const stepper = () =>
        app.execute(
          `return {
             value: document.querySelector('#profile-count')?.value ?? null,
             more: document.querySelector('[data-slot="profile-count-more"]')?.disabled ?? null,
             hint: document.querySelector('[data-slot="profile-count-hint"]')?.innerText ?? "",
             stressed: document.querySelector('[data-slot="profile-count-hint"] [data-limit]')?.innerText ?? null,
           };`,
        );
      // Typing past the cap clamps to it as the digits arrive.
      const typeCount = async (count, shown = count) => {
        await app.clickSelector("#profile-count");
        await app.fillSelector("#profile-count", String(count));
        await app.waitFor(
          async () => (await stepper()).value === String(shown),
          {
            description: `count ${count} shown as ${shown}`,
          },
        );
      };
      const closeDialog = async () => {
        await app.clickTextIn('[role="dialog"]', en.common.buttons.cancel, {
          roles: ["button"],
        });
        await app.waitFor(
          () => app.execute(`return !document.querySelector('#profile-name');`),
          { description: "create dialog closed" },
        );
      };

      // Free: past the allowance the dialog warns, and one profile can
      // still be created, but not a batch.
      await stubCommand(app, "get_profile_creation_allowance", {
        enforcement: "soft",
        per_hour: 8,
        used: 8,
        retry_after_secs: 1_200,
        remaining: 0,
      });
      await openProfileCreation(app);
      await app.waitForText(en.createProfile.hourlyLimit.warningTitle);
      await app.waitForText(en.createProfile.hourlyLimit.warning);
      await app.fillSelector("#profile-name", "Quick profile");
      assert.equal(await createDisabled(), false);
      assert.equal((await stepper()).more, true, "no batch past the allowance");
      await closeDialog();

      // Solo at its cap: Create is disabled and the dialog says why and when.
      await stubCommand(app, "get_profile_creation_allowance", {
        enforcement: "hard",
        per_hour: 10,
        used: 10,
        retry_after_secs: 1_200,
        remaining: 0,
      });
      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Capped profile");
      await app.waitFor(async () => (await createDisabled()) === true, {
        description: "Create disabled at the hourly cap",
      });
      await app.waitForText(
        en.createProfile.hourlyLimit.reached
          .replace("{{limit}}", "10")
          .replace("{{minutes}}", "20"),
      );
      assert.equal(
        await app.execute(
          `return document.body.innerText.includes(arguments[0]);`,
          [en.createProfile.hourlyLimit.warningTitle],
        ),
        false,
        "a capped plan is refused, not warned",
      );
      assert.equal((await stepper()).more, true);
      await closeDialog();

      // Solo with three left: the stepper stops at three and says why.
      await stubCommand(app, "get_profile_creation_allowance", {
        enforcement: "hard",
        per_hour: 10,
        used: 7,
        retry_after_secs: null,
        remaining: 3,
      });
      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Three left");
      for (let i = 0; i < 2; i += 1) {
        await app.clickSelector('[data-slot="profile-count-more"]');
      }
      await app.waitFor(async () => (await stepper()).value === "3", {
        description: "count at the allowance",
      });
      let state = await stepper();
      assert.equal(state.more, true, "+ stops at the allowance");
      await typeCount(9, 3);
      state = await stepper();
      assert.equal(
        state.stressed,
        en.templates.allowanceLeft_other.replace("{{count}}", "3"),
      );
      assert.equal(await createDisabled(), false);
      await closeDialog();

      // Pro: nothing in the footer moves from one profile to a hundred,
      // and a hundred is the most one batch makes.
      await stubCommand(app, "get_profile_creation_allowance", {
        enforcement: "hard",
        per_hour: 100,
        used: 0,
        retry_after_secs: null,
        remaining: 100,
      });
      await openProfileCreation(app);
      await app.fillSelector("#profile-name", "Many");
      await app.waitFor(async () => (await createDisabled()) === false, {
        description: "creation available",
      });
      const single = await createFooterLayout(app);
      for (const count of [9, 10, 100]) {
        await typeCount(count);
        assert.deepEqual(
          await createFooterLayout(app),
          single,
          `the footer at ${count} profiles`,
        );
      }
      await typeCount(250, 100);
      state = await stepper();
      assert.equal(state.more, true, "+ stops at a hundred");
      assert.equal(
        state.stressed,
        en.backendErrors.bulkCreateCountInvalid.replace("{{max}}", "100"),
      );
      await app.capture("profile-create-count-cap");
      await closeDialog();
    },
    { seedDownloadedBrowser: true },
  );
});

/**
 * Where each footer control of the create dialog sits in the dialog, and the
 * dialog's height. Layout boxes, not painted ones: the dialog scales in as it
 * opens, which moves painted boxes by a pixel for a moment.
 */
function createFooterLayout(app) {
  return app.execute(`
    const dialog = document.querySelector('#profile-name').closest('[role="dialog"]');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    const box = (node) => {
      let x = 0;
      let y = 0;
      for (let at = node; at && at !== dialog; at = at.offsetParent) {
        x += at.offsetLeft;
        y += at.offsetTop;
      }
      return [x, y, node.offsetWidth, node.offsetHeight];
    };
    return {
      dialog: dialog.offsetHeight,
      controls: [...footer.querySelectorAll("button, input")].map(box),
    };
  `);
}

/** Stands in for the cloud feedback route and keeps every request it gets. */
async function feedbackCaptureServer() {
  const received = [];
  let status = 201;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          status < 300
            ? {
                id: `fb-${received.length}`,
                createdAt: new Date().toISOString(),
              }
            : { statusCode: status, message: "Too Many Requests" },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}/api/feedback`,
    respondWith(next) {
      status = next;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const FEEDBACK_DIALOG = '[data-dialog="feedback"]';
const MOD = process.platform === "darwin" ? { meta: true } : { ctrl: true };

function feedbackLogsSwitch(app) {
  return app.execute(
    `return document.querySelector('[data-slot="feedback-include-logs"]')?.dataset.state ?? null;`,
  );
}

function feedbackMessage(app) {
  return app.execute(
    `return document.querySelector('[data-slot="feedback-message"]')?.value ?? null;`,
  );
}

test("feedback goes from the More menu to the team, with the logs the person previewed", async () => {
  const capture = await feedbackCaptureServer();
  try {
    await withApp(
      "ui-feedback",
      async (app) => {
        // Refused before anything leaves the machine.
        assert.match(
          await app.invokeError("send_feedback", {
            kind: "bug",
            message: "   ",
            includeLogs: false,
            email: null,
            locale: "en",
          }),
          /FEEDBACK_MESSAGE_EMPTY/,
        );
        assert.match(
          await app.invokeError("send_feedback", {
            kind: "idea",
            message: "More themes",
            includeLogs: false,
            email: "not-an-address",
            locale: "en",
          }),
          /FEEDBACK_EMAIL_INVALID/,
        );
        assert.equal(capture.received.length, 0);
        await app.waitFor(
          async () =>
            (await app.invoke("preview_feedback_logs")).includes(
              "Donut started",
            ),
          { description: "this session's log in the excerpt" },
        );

        // Facts lead the excerpt; a profile shows by alias, never by its
        // name or id, in the facts and in the log lines alike.
        const profile = await createUiProfile(app, "Secret Shop Account");
        const excerpt = await app.invoke("preview_feedback_logs");
        assert.ok(excerpt.startsWith("===== facts =====\n"), excerpt);
        assert.match(excerpt, /^app=\S+ os=\S+ arch=\S+ install=\S+/m);
        assert.match(excerpt, /^profile-1 browser=wayfern /m);
        assert.ok(!excerpt.includes("Secret Shop Account"));
        assert.ok(!excerpt.includes(profile.id));

        await app.clickSelector(`[aria-label="${en.rail.more.label}"]`);
        await app.clickSelector('[data-slot="rail-open-feedback"]');
        await app.waitFor(
          () =>
            app.execute(
              `return Boolean(document.querySelector(arguments[0]));`,
              [FEEDBACK_DIALOG],
            ),
          { description: "the feedback dialog" },
        );
        assert.equal(
          await app.execute(`return document.activeElement?.dataset?.slot;`),
          "feedback-message",
          "the message box has focus at once",
        );
        assert.equal(
          await app.execute(
            `return document.querySelector('[data-slot="feedback-send"]').disabled;`,
          ),
          true,
          "nothing to send yet",
        );

        await app.capture("feedback-open");

        // A bug brings the logs; an idea does not, until the person decides.
        assert.equal(await feedbackLogsSwitch(app), "checked");
        await app.clickSelector(
          '[data-slot="feedback-kind"][data-kind="idea"]',
        );
        assert.equal(await feedbackLogsSwitch(app), "unchecked");
        assert.equal(
          await app.execute(
            `return document.querySelector('[data-slot="feedback-message"]').placeholder;`,
          ),
          en.feedback.kinds.idea.placeholder,
        );
        await app.clickSelector('[data-slot="feedback-kind"][data-kind="bug"]');
        assert.equal(await feedbackLogsSwitch(app), "checked");

        await app.clickSelector('[data-slot="feedback-preview-logs"]');
        await app.waitFor(
          () =>
            app.execute(
              `return document.querySelector('[data-slot="feedback-logs-preview"]')?.value.includes("Donut started") ?? false;`,
            ),
          { description: "the log preview" },
        );

        await app.fillSelector(
          '[data-slot="feedback-message"]',
          "The proxy check never finishes",
        );
        await app.fillSelector(
          '[data-slot="feedback-email"]',
          "me@example.com",
        );
        await app.capture("feedback-compose");
        await app.clickSelector('[data-slot="feedback-send"]');
        await app.waitFor(
          () =>
            app.execute(
              `return Boolean(document.querySelector('[data-slot="feedback-sent"]'));`,
            ),
          { description: "the thank-you view" },
        );
        assert.ok(await app.visibleTextIncludes(en.feedback.success.title));
        assert.ok(
          await app.visibleTextIncludes(
            en.feedback.success.reply.replace("{{email}}", "me@example.com"),
          ),
        );
        await app.capture("feedback-sent");

        assert.equal(capture.received.length, 1);
        const [sent] = capture.received;
        assert.equal(sent.method, "POST");
        assert.equal(sent.url, "/api/feedback");
        assert.equal(
          sent.headers.authorization,
          undefined,
          "signed out, so no account",
        );
        assert.equal(sent.body.kind, "bug");
        assert.equal(sent.body.source, "person");
        assert.equal(sent.body.message, "The proxy check never finishes");
        assert.equal(sent.body.email, "me@example.com");
        assert.equal(sent.body.locale, "en");
        assert.equal(typeof sent.body.appVersion, "string");
        assert.ok(sent.body.logs.includes("Donut started"));

        await app.clickSelector('[data-slot="feedback-sent"] button');
        await app.waitFor(
          async () =>
            (await app.execute(
              `return Boolean(document.querySelector(arguments[0]));`,
              [FEEDBACK_DIALOG],
            )) === false,
          { description: "the dialog closed" },
        );
        await app.waitFor(
          async () =>
            (await app.invoke("get_app_settings")).feedback_sent_at > 0,
          { description: "the sent feedback remembered for the tips" },
        );

        // The chord opens a fresh dialog: a sent draft does not come back.
        await app.pressShortcut({ ...MOD, shift: true, key: "f" });
        await app.waitFor(async () => (await feedbackMessage(app)) === "", {
          description: "an empty dialog from the keyboard",
        });

        // A refusal keeps the draft and says why.
        capture.respondWith(429);
        await app.clickSelector(
          '[data-slot="feedback-kind"][data-kind="idea"]',
        );
        await app.fillSelector(
          '[data-slot="feedback-message"]',
          "Dark tray icon",
        );
        await app.pressShortcut({ ...MOD, key: "\uE007" });
        await app.waitForText(en.backendErrors.feedbackRateLimited);
        assert.equal(await feedbackMessage(app), "Dark tray icon");
        assert.equal(capture.received.length, 2);
        assert.equal(capture.received[1].body.kind, "idea");
        assert.equal(
          capture.received[1].body.logs,
          undefined,
          "an idea was sent without logs",
        );

        // Closing keeps the unsent draft. The feedback tip leads back to it.
        await app.pressShortcut({ key: "Escape" });
        await app.waitFor(
          async () =>
            (await app.execute(
              `return Boolean(document.querySelector(arguments[0]));`,
              [FEEDBACK_DIALOG],
            )) === false,
          { description: "the dialog closed with a draft" },
        );
        await openTipsFromRail(app);
        await app.clickSelector(
          '[data-slot="tips-list-item"][data-tip-id="feedback"]',
        );
        assert.ok(await app.visibleTextIncludes(en.tips.items.feedback.title));
        await app.capture("feedback-tip");
        await app.clickSelector('[data-slot="tip-action"]');
        await app.waitFor(
          async () => (await feedbackMessage(app)) === "Dark tray icon",
          { description: "the draft back in the dialog from the tip" },
        );
      },
      { extraEnv: { DONUT_E2E_FEEDBACK_URL: capture.url } },
    );
  } finally {
    await capture.close();
  }
});

async function signInAs(app, id, plan, subscriptionStatus, extra = {}) {
  await stubCommand(app, "cloud_get_user", {
    logged_in_at: new Date().toISOString(),
    user: {
      id,
      email: `${id}@example.test`,
      plan,
      planPeriod: "monthly",
      subscriptionStatus,
      profileLimit: plan === "free" ? 0 : 20,
      cloudProfilesUsed: 0,
      proxyBandwidthLimitMb: 0,
      proxyBandwidthUsedMb: 0,
      proxyBandwidthExtraMb: 0,
      isPrimaryDevice: true,
      ...extra,
    },
  });
  await app.invoke("plugin:event|emit", {
    event: "cloud-auth-changed",
    payload: null,
  });
}

const SYNC_SOURCE_LINE = '[data-slot="account-sync-source"]';

function pickedSyncSource(app) {
  return app.execute(
    `return document.querySelector('[data-slot="account-sync-source-choice"] [role="radio"][aria-checked="true"]')?.textContent?.trim() ?? null;`,
  );
}

test("a paid account keeps its own sync server behind one quiet line", async () => {
  await withApp("ui-account-sync-server", async (app) => {
    await app.waitForText("No profiles yet");
    const own = en.account.ownServer;
    const server = "https://sync.example.test";
    try {
      await stubCommand(app, "get_sync_source", {
        active: "cloud",
        account_server: null,
        self_hosted_server: null,
      });
      await stubCommand(app, "check_sync_server_connection", {
        server_reachable: true,
        storage_ready: true,
        storage_endpoint: null,
        storage_reachable: null,
        storage_error: null,
        account_url: server,
      });
      await stubCommand(app, "set_account_sync_server", {
        active: "account",
        account_server: server,
        self_hosted_server: null,
      });
      await stubCommand(app, "set_sync_source", {
        active: "cloud",
        account_server: server,
        self_hosted_server: null,
      });
      await stubCommand(app, "restart_sync_service", null);
      await signInAs(app, "ui-account-sync-server", "solo", "active");
      // A paid account opens the one-time welcome; close it when it comes.
      const welcomed = await app
        .waitFor(
          () =>
            app.execute(
              `return Boolean(document.querySelector('[role="dialog"]'));`,
            ),
          { timeoutMs: 4000, description: "the paid welcome" },
        )
        .catch(() => false);
      if (welcomed) await dismissSurface(app);

      await app.clickSelector(`[aria-label="${en.rail.account}"]`);
      const line = await app.waitFor(
        () =>
          app.execute(
            `return document.querySelector(arguments[0])?.innerText ?? "";`,
            [SYNC_SOURCE_LINE],
          ),
        { description: "the sync server line" },
      );
      assert.ok(line.includes(own.label), line);
      assert.ok(line.includes(own.donutCloud), line);
      // Signed in, there is no self-hosted tab, and the address form waits
      // behind Change.
      assert.equal(
        await app.execute(
          `return [...document.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent.trim() === arguments[0]);`,
          [en.account.tabs.selfHosted],
        ),
        false,
      );
      assert.equal(
        await app.execute(
          `return Boolean(document.querySelector('#account-sync-server-url, #self-hosted-token'));`,
        ),
        false,
      );

      await app.clickTextIn(SYNC_SOURCE_LINE, own.change);
      await app.fillSelector("#account-sync-server-url", `${server}/`);
      await app.clickTextIn(
        SYNC_SOURCE_LINE,
        en.account.selfHosted.testConnection,
      );
      await app.waitForText(own.accountsOn);
      await app.clickTextIn(SYNC_SOURCE_LINE, en.common.buttons.save);
      await app.waitForText(
        own.switched.replace("{{server}}", "sync.example.test"),
      );
      await app.waitFor(
        async () => (await pickedSyncSource(app)) === "sync.example.test",
        { description: "the own server picked" },
      );
      assert.ok(await app.visibleTextIncludes(own.cloudOnly));
      await app.capture("account-sync-server");

      // Back to Donut cloud in one click; the server stays offered.
      await app.clickTextIn(SYNC_SOURCE_LINE, own.donutCloud, {
        roles: ["radio"],
      });
      await app.waitFor(
        async () => (await pickedSyncSource(app)) === own.donutCloud,
        { description: "Donut cloud picked" },
      );
      await app.waitForText(own.backToCloud);

      const calls = await app.execute(
        `return (window.__donutStubbedCalls ?? []).filter((call) => ["set_account_sync_server", "set_sync_source", "restart_sync_service"].includes(call.command));`,
      );
      assert.deepEqual(
        calls.map((call) => call.command),
        [
          "set_account_sync_server",
          "restart_sync_service",
          "set_sync_source",
          "restart_sync_service",
        ],
      );
      assert.equal(calls[0].payload.serverUrl, `${server}/`);
      assert.equal(calls[2].payload.source, "cloud");
    } finally {
      await restoreStubs(app);
    }
  });
});

test("a signed-in free account starts on Donut cloud and may pick a server set up signed out", async () => {
  await withApp("ui-account-sync-choice", async (app) => {
    await app.waitForText("No profiles yet");
    const own = en.account.ownServer;
    const shared = "https://shared.example.test";
    try {
      await stubCommand(app, "get_sync_source", {
        active: "cloud",
        account_server: null,
        self_hosted_server: shared,
      });
      await stubCommand(app, "set_sync_source", {
        active: "self_hosted",
        account_server: null,
        self_hosted_server: shared,
      });
      await stubCommand(app, "restart_sync_service", null);
      await signInAs(app, "ui-account-sync-choice", "free", "inactive");

      await app.clickSelector(`[aria-label="${en.rail.account}"]`);
      await app.waitFor(
        async () => (await pickedSyncSource(app)) === own.donutCloud,
        { description: "Donut cloud picked by default" },
      );
      // A free account gets no way to add a server.
      assert.equal(
        await app.execute(
          `return [...document.querySelectorAll(arguments[0] + " button")].some((button) => button.textContent.trim() === arguments[1]);`,
          [SYNC_SOURCE_LINE, own.change],
        ),
        false,
      );

      await app.clickTextIn(SYNC_SOURCE_LINE, "shared.example.test", {
        roles: ["radio"],
      });
      await app.waitFor(
        async () => (await pickedSyncSource(app)) === "shared.example.test",
        { description: "the shared-token server picked" },
      );
      await app.waitForText(
        own.switched.replace("{{server}}", "shared.example.test"),
      );
      assert.ok(await app.visibleTextIncludes(own.cloudOnly));

      const calls = await app.execute(
        `return (window.__donutStubbedCalls ?? []).filter((call) => call.command === "set_sync_source");`,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].payload.source, "self_hosted");

      // A team seat is never offered a sync-token server.
      await signInAs(app, "ui-account-sync-choice", "free", "inactive", {
        teamId: "team-1",
        teamName: "Team",
        teamRole: "member",
      });
      await app.waitFor(
        () =>
          app.execute(
            `return ![...document.querySelectorAll('[data-slot="account-sync-source-choice"] [role="radio"]')].some((radio) => radio.textContent.trim() === arguments[0]);`,
            ["shared.example.test"],
          ),
        { description: "no sync-token server for a team seat" },
      );
    } finally {
      await restoreStubs(app);
    }
  });
});
