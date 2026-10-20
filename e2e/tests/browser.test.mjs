import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import { appFromEnvironment } from "../lib/app.mjs";
import { CdpClient } from "../lib/cdp.mjs";
import {
  cachedFixtureVersion,
  currentHostOs,
  prepareWayfern,
  writeUnpackedExtension,
} from "../lib/fixtures.mjs";

const fixtureUrl = process.env.DONUT_E2E_FIXTURE_URL;

async function request(url, { method = "GET", token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { response, value };
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  if (process.platform === "win32") {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ],
      { encoding: "utf8" },
    );
  }
  return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
}

async function waitForProcessExit(app, pid) {
  await app.waitFor(() => !processExists(pid), {
    timeoutMs: 20_000,
    description: `Wayfern process ${pid} to exit`,
  });
}

function assertIdleResourceBounds(pid) {
  if (process.platform === "win32") return;
  const output = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  const [rssText, cpuText] = output.split(/\s+/);
  const rssKiB = Number(rssText);
  const cpuPercent = Number(cpuText);
  assert.ok(
    rssKiB > 0 && rssKiB < 2_000_000,
    `Wayfern main process RSS is ${rssKiB} KiB`,
  );
  assert.ok(
    cpuPercent >= 0 && cpuPercent < 200,
    `Wayfern main process CPU is ${cpuPercent}%`,
  );
}

function realWayfernTermsPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Wayfern",
      "license-accepted",
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "Wayfern",
      "license-accepted",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "Wayfern",
    "license-accepted",
  );
}

async function snapshotFile(file) {
  try {
    const [contents, metadata] = await Promise.all([
      readFile(file),
      stat(file, { bigint: true }),
    ]);
    return {
      exists: true,
      contents: contents.toString("base64"),
      size: metadata.size.toString(),
      mtime: metadata.mtimeNs.toString(),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

/**
 * The exit-derived fields `WayfernConfig.location` may hold. Mirrors
 * `LOCALE_CARRY_OVER_KEYS` in wayfern_manager.rs: anything outside this set is
 * a device field, and a device field never belongs to the location.
 */
const LOCATION_KEYS = new Set([
  "timezone",
  "timezoneOffset",
  "language",
  "languages",
  "latitude",
  "longitude",
  "accuracy",
]);

/**
 * The MCP tools as an agent reaches them over the remote bridge, on one
 * initialized session. `tool` fails on an error answer; `toolError` expects one
 * and returns it.
 */
async function mcpClient(base, token, profileId) {
  let rpcId = 0;
  let session = null;
  const post = async (method, params) => {
    const response = await fetch(`${base}/v1/e2e/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const answer = await response.json();
    session = answer.session_id ?? session;
    return answer.body;
  };
  const mcp = async (method, params) => {
    const body = await post(method, params);
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result;
  };
  const call = (name, args) =>
    post("tools/call", {
      name,
      arguments: { profile_id: profileId, ...args },
    });
  const tool = async (name, args = {}) => {
    const body = await call(name, args);
    assert.equal(body.error, undefined, JSON.stringify(body));
    assert.notEqual(body.result.isError, true, JSON.stringify(body.result));
    return body.result.content[0];
  };
  const toolJson = async (name, args) =>
    JSON.parse((await tool(name, args)).text);
  const toolError = async (name, args = {}) => {
    const body = await call(name, args);
    assert.ok(body.error, JSON.stringify(body));
    return body.error;
  };
  await mcp("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "Donut E2E", version: "1" },
  });
  return { mcp, tool, toolJson, toolError };
}

/** `fingerprint` is the serialised fingerprint STRING, or null for a fresh one. */
async function createRealProfile(app, version, name, fingerprint = null) {
  return app.invoke("create_browser_profile_new", {
    name,
    browserStr: "wayfern",
    version,
    releaseType: "stable",
    proxyId: null,
    vpnId: null,
    wayfernConfig: {
      fingerprint,
      randomize_fingerprint_on_launch: false,
      geoip: false,
    },
    groupId: null,
    ephemeral: false,
    dnsBlocklist: null,
    launchHook: null,
  });
}

test("real Wayfern fingerprinting, terms, API automation, CDP, cookies, and process cleanup", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const realTermsFile = realWayfernTermsPath();
  const realTermsBefore = await snapshotFile(realTermsFile);
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-wayfern", {
    seedVersionCache: localWayfernVersion ?? false,
    wayfernTermsAccepted: false,
  });
  let cdp;
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();

    assert.equal(await app.invoke("check_wayfern_downloaded"), true);
    assert.equal(await app.invoke("check_wayfern_terms_accepted"), false);
    // The gate is a real modal until the terms are accepted, and acceptance
    // through the bridge (not the dialog's own button) must lift it too: the
    // frontend learns about the marker from the backend's event, not from a
    // restart.
    const termsDialogVisible = () =>
      app.execute(
        `return [...document.querySelectorAll('[role="dialog"]')].some(node => node.textContent.includes(arguments[0]));`,
        [en.wayfernTerms.title],
      );
    await app.waitFor(termsDialogVisible, {
      description: "the Wayfern terms dialog before acceptance",
    });
    await app.invoke("accept_wayfern_terms");
    assert.equal(await app.invoke("check_wayfern_terms_accepted"), true);
    await app.waitFor(async () => !(await termsDialogVisible()), {
      description: "the Wayfern terms dialog to close after acceptance",
    });
    assert.ok(
      (
        await app.invoke("get_downloaded_browser_versions", {
          browserStr: "wayfern",
        })
      ).includes(prepared.version),
    );
    assert.equal(
      await app.invoke("check_browser_exists", {
        browserStr: "wayfern",
        version: prepared.version,
      }),
      true,
    );
    assert.deepEqual(await app.invoke("check_missing_binaries"), []);
    assert.deepEqual(await app.invoke("ensure_all_binaries_exist"), []);
    assert.deepEqual(await app.invoke("ensure_active_browsers_downloaded"), []);
    assert.deepEqual(await app.invoke("get_supported_browsers"), ["wayfern"]);
    assert.equal(
      await app.invoke("is_browser_supported_on_platform", {
        browserStr: "wayfern",
      }),
      true,
    );
    assert.ok(
      (
        await app.invoke("fetch_browser_versions_cached_first", {
          browserStr: "wayfern",
        })
      ).some((item) => item.version === prepared.version),
    );
    assert.ok(
      (
        await app.invoke("fetch_browser_versions_with_count_cached_first", {
          browserStr: "wayfern",
        })
      ).versions.includes(prepared.version),
    );
    // The app's own resolver must agree with the release manifest the harness
    // read when it decided the cached fixture was current. If these two ever
    // diverge, the fixture check compares against a version the app will never
    // ask for, and the suite silently runs an old browser again.
    assert.ok(
      (
        await app.invoke("fetch_browser_versions_with_count", {
          browserStr: "wayfern",
        })
      ).versions.includes(prepared.version),
      "the app must resolve the same published version the fixture was chosen for",
    );
    assert.equal(
      (await app.invoke("get_browser_release_types", { browserStr: "wayfern" }))
        .stable,
      prepared.version,
    );
    assert.match(
      await app.invokeError("cancel_download", {
        browserStr: "wayfern",
        version: prepared.version,
      }),
      /No active download/,
    );

    const sample = await app.invoke("generate_sample_fingerprint", {
      browser: "wayfern",
      version: prepared.version,
      configJson: JSON.stringify({ geoip: false }),
    });
    const fingerprint = JSON.parse(sample.fingerprint);
    assert.ok(
      Object.keys(fingerprint).length >= 10,
      "Wayfern returned an incomplete fingerprint",
    );
    // A browser with the identity API must hand back the UUID the device was
    // derived from. The device itself is a view to show once and discard: an
    // identity-backed profile stores the id and the exit's location, never the
    // payload, so no fingerprint sits on disk to be copied.
    const identityCapable =
      Number.parseInt(prepared.version.split(".")[0], 10) >= 151;
    assert.equal(
      typeof sample.identity_id === "string",
      identityCapable,
      "identity_id must be present exactly on browsers with the identity API",
    );
    assert.equal(
      sample.identity_baseline,
      undefined,
      "the retired identity baseline must not be handed back",
    );
    assert.ok(
      sample.location === null || typeof sample.location === "string",
      "location is the exit-derived JSON object, or null when none resolved",
    );
    if (typeof sample.location === "string") {
      const locationKeys = Object.keys(JSON.parse(sample.location));
      assert.ok(locationKeys.length > 0, "a resolved location is never empty");
      for (const key of locationKeys) {
        assert.ok(
          LOCATION_KEYS.has(key),
          `${key} is a device field and must not travel in the location`,
        );
      }
    }

    const profile = await createRealProfile(
      app,
      prepared.version,
      `Real Wayfern (${prepared.source})`,
    );
    // An identity-backed profile stores the identity and the location and never
    // the device: the browser rebuilds it from the id on every launch. A legacy
    // browser stores the whole payload.
    assert.equal(
      typeof profile.wayfern_config.identity_id === "string",
      identityCapable,
      "a created profile must carry the identity its device came from",
    );
    assert.equal(
      profile.wayfern_config.fingerprint === undefined,
      identityCapable,
      "an identity-backed profile must store no device payload",
    );
    if (!identityCapable) {
      assert.ok(
        Object.keys(JSON.parse(profile.wayfern_config.fingerprint)).length >=
          10,
      );
    }
    assert.equal(await app.invoke("check_missing_geoip_database"), true);
    assert.equal(await app.invoke("is_geoip_database_available"), false);
    await app.invoke("download_geoip_database");
    assert.equal(await app.invoke("is_geoip_database_available"), true);
    assert.equal(await app.invoke("check_missing_geoip_database"), false);

    // The new-profile form (which needs a downloaded browser and its release
    // types, so it renders here and not in the UI suite): session restore is
    // on by default and the checkbox is a live control. It sits under the
    // collapsed advanced options.
    await app.clickSelector('[aria-label="Profiles"]');
    await app.clickText("New");
    await app.clickText(en.createProfile.advancedOptions, {
      roles: ["button"],
    });
    const restoreChecked = () =>
      app.execute(
        `return document.querySelector("#restore-session")?.getAttribute("aria-checked") ?? null;`,
      );
    await app.waitFor(async () => (await restoreChecked()) !== null, {
      description: "the session-restore checkbox in the new-profile form",
    });
    assert.equal(
      await restoreChecked(),
      "true",
      "a new profile must default to continuing its last session",
    );
    await app.clickSelector("#restore-session");
    await app.waitFor(async () => (await restoreChecked()) === "false", {
      description: "the session-restore checkbox to switch off",
    });
    await app.pressShortcut({ key: "Escape" });
    await app.waitFor(
      () =>
        app.execute(
          `return !document.querySelector("[role='dialog'] #restore-session");`,
        ),
      { description: "the new-profile dialog to close" },
    );

    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: profile.wayfern_config,
    });
    await app.invoke("match_profile_fingerprint_to_exit", {
      profileId: profile.id,
      exitIp: "8.8.8.8",
    });
    // The identity is internal state that neither call above sends back.
    // Losing it would silently re-mint the device on the next launch and throw
    // the user's edits away with it, so both paths must carry it forward
    // unchanged. The exit re-match moves only the location: the profile comes
    // out of it still identity-only, with the exit's timezone stored.
    if (identityCapable) {
      const stored = (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );
      assert.equal(
        stored.wayfern_config.identity_id,
        profile.wayfern_config.identity_id,
        "the identity must survive update_wayfern_config and an exit re-match",
      );
      assert.equal(
        stored.wayfern_config.fingerprint,
        undefined,
        "neither call may leave a device payload behind",
      );
      assert.equal(
        typeof JSON.parse(stored.wayfern_config.location).timezone,
        "string",
        "an exit re-match stores the exit's timezone in the location",
      );
    }
    // The session-restore switch is profile configuration and round-trips
    // like the rest of it; `undefined` (the default) reads as on.
    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: {
        ...(await app.invoke("list_browser_profiles")).find(
          (p) => p.id === profile.id,
        ).wayfern_config,
        restore_session: false,
      },
    });
    assert.equal(
      (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      ).wayfern_config.restore_session,
      false,
      "restore_session must persist through update_wayfern_config",
    );

    // The persona the browser will offer in its fill menu: derived from the
    // profile's own seed, so it is stable for this profile, unique to it, and
    // never empty.
    const persona = await app.invoke("get_profile_persona", {
      profileId: profile.id,
    });
    assert.ok(
      persona.length >= 8,
      "a persona carries the fields to fill a form",
    );
    assert.deepEqual(
      await app.invoke("get_profile_persona", { profileId: profile.id }),
      persona,
      "the same profile presents the same person every time",
    );
    for (const entry of persona) {
      assert.ok(entry.id && entry.label && entry.value.trim());
    }
    const email = persona.find((entry) => entry.id === "email");
    assert.match(email.value, /@/);
    assert.match(
      await app.invokeError("get_profile_persona", {
        profileId: "00000000-0000-0000-0000-000000000000",
      }),
      /PROFILE_NOT_FOUND/,
    );
    // An edit replaces one value and leaves the rest derived.
    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: {
        ...(await app.invoke("list_browser_profiles")).find(
          (p) => p.id === profile.id,
        ).wayfern_config,
        persona: JSON.stringify([
          { id: "email", label: "Email", value: "someone@example.com" },
        ]),
      },
    });
    const edited = await app.invoke("get_profile_persona", {
      profileId: profile.id,
    });
    assert.equal(
      edited.find((entry) => entry.id === "email").value,
      "someone@example.com",
    );
    assert.equal(
      edited.find((entry) => entry.id === "full_name").value,
      persona.find((entry) => entry.id === "full_name").value,
      "an edit to one field must not redraw the others",
    );
    // What "reset to generated" shows: the person before any edit.
    assert.deepEqual(
      await app.invoke("get_profile_persona", {
        profileId: profile.id,
        derivedOnly: true,
      }),
      persona,
    );

    // Pre-launch gate: local-only checks that must answer without starting a
    // proxy, an Xray worker or the browser.
    const checks = await app.invoke("get_profile_pre_launch_checks", {
      profileId: profile.id,
    });
    assert.ok(Array.isArray(checks.vpn_extensions));
    assert.equal(
      typeof checks.scan_state,
      "string",
      "the scan must report whether it saw the whole profile",
    );
    assert.equal(typeof checks.consistency, "object");
    assert.equal(typeof checks.exit_probe_pending, "boolean");
    assert.equal(typeof checks.exit_measurement_unreliable, "boolean");
    // A profile with no proxy or VPN has no route to check before launch.
    assert.equal(checks.route_unreachable, null);
    // The third consistency state: what no probe can ever verify for this
    // profile. Reported so a launch that compared nothing is never rendered as
    // a launch that compared everything and agreed.
    assert.ok(
      Array.isArray(checks.exit_unverified),
      "the pre-launch report must say what it cannot verify",
    );
    assert.ok(
      Array.isArray(checks.consistency.unverified),
      "a consistency result must carry the dimensions nothing compared",
    );
    // "Donut will check it while starting" is only sayable while some
    // dimension is still checkable. Both dimensions unverifiable means the
    // probe would compare nothing, so it is not pending work.
    assert.ok(
      !checks.exit_probe_pending || checks.exit_unverified.length < 2,
      "a probe that can compare nothing must not be reported as pending",
    );
    // This profile has no VPN extension, so nothing may block its launch.
    assert.equal(
      checks.vpn_extensions.length,
      0,
      "a clean profile must not report a VPN extension",
    );
    assert.equal(
      checks.consent_token,
      null,
      "a consent token is only minted when a cached mismatch is blocking",
    );

    // Extension detection, against manifests written where Chromium puts
    // them. The three cases are the whole point of the classifier: a real VPN
    // is named as one, a known VPN with an unrevealing name is caught by its
    // id, and a download manager holding the same `proxy` permission is
    // reported as a capability and never as a VPN.
    // `DONUTBROWSER_DATA_ROOT` puts the data dir at <dataRoot>/data, so this
    // is app_dirs::profiles_dir() plus the layout Chromium itself uses.
    const extensionsDir = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
      "Extensions",
    );
    const seedExtension = async (id, version, manifest) => {
      const dir = path.join(extensionsDir, id, `${version}_0`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify(manifest),
      );
    };
    const IDM_ID = "ngpampappnmepgilojfohadhhmbhlaek";
    const HOTSPOT_SHIELD_ID = "nlbejmccbhkncgokjcmghpfloaajcffj";
    const NAMED_VPN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await seedExtension(IDM_ID, "6.43.1", {
      name: "IDM Integration Module",
      version: "6.43.1",
      description: "Download files with Internet Download Manager",
      permissions: ["downloads", "storage", "proxy", "nativeMessaging"],
    });
    await seedExtension(HOTSPOT_SHIELD_ID, "10.0.0", {
      name: "Hotspot Shield",
      version: "10.0.0",
      permissions: ["proxy"],
    });
    await seedExtension(NAMED_VPN_ID, "1.0.0", {
      name: "Turbo VPN Free",
      version: "1.0.0",
      permissions: ["proxy"],
    });

    const withExtensions = await app.invoke("get_profile_pre_launch_checks", {
      profileId: profile.id,
    });
    const detected = new Map(
      withExtensions.vpn_extensions.map((item) => [item.key, item]),
    );
    assert.equal(detected.size, 3, "every seeded extension must be reported");
    assert.equal(detected.get(`crx:${NAMED_VPN_ID}`).confidence, "confirmed");
    assert.equal(
      detected.get(`crx:${HOTSPOT_SHIELD_ID}`).confidence,
      "confirmed",
      "a known VPN id must be named even when its name gives nothing away",
    );
    assert.equal(
      detected.get(`crx:${IDM_ID}`).confidence,
      "capability",
      "a download manager holding the proxy permission is not a VPN",
    );
    assert.ok(
      detected.get(`crx:${IDM_ID}`).proxy_control,
      "it does still hold the permission, which is why it is listed at all",
    );
    assert.equal(
      withExtensions.exit_measurement_unreliable,
      true,
      "a proxy-capable extension makes the exit measurement a caveat",
    );

    // Acknowledgements are per-profile and must be accepted for both kinds.
    await app.invoke("ack_launch_gate", {
      profileId: profile.id,
      ackFingerprint: false,
      ackExtensionKeys: ["crx:e2e-nonexistent-extension"],
    });
    await app.invoke("ack_launch_gate", {
      profileId: profile.id,
      ackFingerprint: true,
      ackExtensionKeys: [`crx:${IDM_ID}`],
    });
    const afterAck = await app.invoke("get_profile_pre_launch_checks", {
      profileId: profile.id,
    });
    assert.deepEqual(
      afterAck.vpn_extensions.map((item) => item.key).sort(),
      [`crx:${HOTSPOT_SHIELD_ID}`, `crx:${NAMED_VPN_ID}`].sort(),
      "an acknowledged extension stops being reported, the others do not",
    );
    assert.match(
      await app.invokeError("get_profile_pre_launch_checks", {
        profileId: "00000000-0000-0000-0000-000000000000",
      }),
      /PROFILE_NOT_FOUND/,
    );

    const directProfile = (await app.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    const directLaunch = await app.invoke("launch_browser_profile", {
      profile: directProfile,
      url: `${fixtureUrl}/direct-command`,
    });
    assert.ok(directLaunch.process_id);
    await app.invoke("open_url_with_profile", {
      profileId: profile.id,
      url: `${fixtureUrl}/direct-open`,
    });
    await app.invoke("kill_browser_profile", { profile: directLaunch });
    await waitForProcessExit(app, directLaunch.process_id);

    const settings = await app.invoke("get_app_settings");
    const saved = await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        api_enabled: true,
        api_port: 0,
        api_token: null,
        onboarding_completed: true,
      },
    });
    const port = await app.invoke("start_api_server", { port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const launched = await request(`${base}/v1/profiles/${profile.id}/run`, {
      method: "POST",
      token: saved.api_token,
      body: { url: `${fixtureUrl}/wayfern`, headless: true },
    });
    assert.equal(launched.response.status, 200, JSON.stringify(launched.value));
    assert.equal(launched.value.headless, true);

    cdp = await CdpClient.connect(launched.value.remote_debugging_port);
    await cdp.waitFor(`document.title === "Donut E2E Browser Fixture"`, {
      description: "fixture page title",
    });
    assert.equal(
      await cdp.evaluate("document.querySelector('#path').textContent"),
      "/wayfern",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-button').click(); document.querySelector('#fixture-button').dataset.clicked",
      ),
      "yes",
    );
    const echo = await cdp.evaluate(
      `fetch(${JSON.stringify(`${fixtureUrl}/api/echo`)}, {
        method: "POST",
        body: "wayfern-cdp-body"
      }).then((response) => response.json())`,
    );
    assert.equal(echo.method, "POST");
    assert.equal(echo.body, "wayfern-cdp-body");
    assert.ok(echo.userAgent.length > 20);
    assert.match(await cdp.evaluate("document.cookie"), /donut_e2e=browser-ok/);

    // A click that only changes the page ends a moment after the click, not
    // at the load timeout; a link click still waits for its load and says so.
    const agentClick = async (locator) => {
      const started = Date.now();
      const answer = await request(
        `${base}/v1/profiles/${profile.id}/agent/click`,
        { method: "POST", token: saved.api_token, body: { locator } },
      );
      assert.equal(answer.response.status, 200, JSON.stringify(answer.value));
      return { ...answer.value, ms: Date.now() - started };
    };
    const inPlace = await agentClick({ role: "button", name: "Clicked" });
    assert.equal(inPlace.navigated, false);
    assert.ok(inPlace.ms < 5000, `an in-place click took ${inPlace.ms} ms`);
    const link = await agentClick({
      role: "link",
      name: "Open the linked page",
    });
    assert.equal(link.navigated, true);
    assert.equal(
      await cdp.evaluate("document.querySelector('#path').textContent"),
      "/linked",
    );

    // The browser's own index never carries `id`, so the page applies this
    // locator; the node a resolution names is the element itself.
    const byIdLocator = {
      attributes: [{ name: "id", value: "fixture-button" }],
    };
    const resolved = await request(
      `${base}/v1/profiles/${profile.id}/agent/resolve-locator`,
      {
        method: "POST",
        token: saved.api_token,
        body: { locator: byIdLocator },
      },
    );
    assert.equal(resolved.response.status, 200, JSON.stringify(resolved.value));
    const resolvedNode = await cdp.command("DOM.describeNode", {
      backendNodeId: resolved.value.backendNodeId,
    });
    assert.equal(resolvedNode.node.nodeName, "BUTTON");
    assert.ok(
      resolvedNode.node.attributes.includes("fixture-button"),
      JSON.stringify(resolvedNode.node),
    );
    const byId = await agentClick(byIdLocator);
    assert.equal(byId.navigated, false);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-button').dataset.clicked",
      ),
      "yes",
    );

    // The MCP browser tools, through the engine an agent reaches over the
    // remote bridge. Each action says where the page is afterwards.
    const { mcp, tool, toolJson, toolError } = await mcpClient(
      base,
      saved.api_token,
      profile.id,
    );

    // What a bug report attaches, as an agent reads it: the running profile
    // by alias, never by id, inside the size the agent asked for.
    const { diagnostics } = await toolJson("get_diagnostics", { max_kb: 16 });
    assert.ok(
      diagnostics.startsWith("===== facts =====\n"),
      diagnostics.slice(0, 400),
    );
    assert.match(diagnostics, /^profile-\d+ browser=wayfern .*running=true/m);
    assert.ok(!diagnostics.includes(profile.id));
    assert.ok(Buffer.byteLength(diagnostics) <= 16 * 1024);
    assert.match(
      (await toolError("get_diagnostics", { max_kb: 1 })).message,
      /max_kb/,
    );

    // The device the profile presents, through each way it is read: the
    // fingerprint form, REST and MCP. An identity-backed profile stores no
    // device, so every read derives it, and it is what the running page reports.
    const shown = JSON.parse(
      await app.invoke("get_profile_fingerprint", { profileId: profile.id }),
    );
    assert.ok(Object.keys(shown).length >= 10, JSON.stringify(shown));
    assert.equal(shown.platform, await cdp.evaluate("navigator.platform"));
    assert.equal(
      shown.hardwareConcurrency,
      await cdp.evaluate("navigator.hardwareConcurrency"),
    );
    const restFingerprint = await request(
      `${base}/v1/profiles/${profile.id}/fingerprint`,
      { token: saved.api_token },
    );
    assert.equal(
      restFingerprint.response.status,
      200,
      JSON.stringify(restFingerprint.value),
    );
    assert.deepEqual(JSON.parse(restFingerprint.value.fingerprint), shown);
    assert.deepEqual(
      JSON.parse((await toolJson("get_profile_fingerprint")).fingerprint),
      shown,
    );

    const back = await tool("go_back");
    assert.match(back.text, /^Went back/);
    assert.match(back.text, /Page: Donut E2E Browser Fixture <.*\/wayfern>/);
    assert.equal(
      await cdp.evaluate("document.querySelector('#path').textContent"),
      "/wayfern",
    );

    const scrolled = await toolJson("scroll", { direction: "down" });
    assert.equal(scrolled.moved, true, JSON.stringify(scrolled));
    assert.ok(scrolled.scroll_y > 0);
    assert.equal(scrolled.at_top, false);

    await cdp.evaluate("document.querySelector('#fixture-input').focus()");
    const pressed = await tool("press_key", { key: "Enter" });
    assert.match(pressed.text, /^Pressed Enter/);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-input').dataset.entered",
      ),
      "yes",
    );

    const found = await toolJson("wait_for", { selector: "#fixture-end" });
    assert.equal(found.met, true);
    assert.equal(found.title, "Donut E2E Browser Fixture");
    const missing = await toolJson("wait_for", {
      text: "Text that is never on the fixture",
      timeout_ms: 300,
    });
    assert.equal(missing.met, false);

    // Each listed element carries an id that stays the same while it lives;
    // a batch acts on one by id and reports each step.
    const listing = (await tool("get_interactive_elements")).text;
    const buttonLine = listing
      .split("\n")
      .find((line) => line.includes('id="fixture-button"'));
    const elementId = /^\[\d+ (e\d+)/.exec(buttonLine ?? "")?.[1];
    assert.ok(elementId, listing);
    assert.doesNotMatch(
      (await tool("get_interactive_elements")).text,
      / new[\] ]/,
      "nothing is new on a second listing of the same page",
    );
    await cdp.evaluate(
      "delete document.querySelector('#fixture-button').dataset.clicked; true",
    );
    const batch = await toolJson("run_actions", {
      actions: [
        { tool: "click_by_index", arguments: { element_id: elementId } },
        { tool: "get_page_info" },
      ],
    });
    assert.equal(batch.completed, 2, JSON.stringify(batch));
    assert.equal(batch.stopped, null);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-button').dataset.clicked",
      ),
      "yes",
    );

    // Form tools on a native select and a hidden file input added to the page.
    await cdp.evaluate(`(() => {
      const form = document.createElement('form');
      form.innerHTML = '<label for="fixture-country">Country</label>'
        + '<select id="fixture-country"><option value="">Pick one</option>'
        + '<option value="de">Germany</option><option value="fr">France</option></select>'
        + '<select id="fixture-langs" multiple><option value="en">English</option>'
        + '<option value="de">German</option></select>'
        + '<label id="fixture-upload-label">Attach'
        + '<input id="fixture-file" type="file" style="display: none"></label>';
      document.body.prepend(form);
      const country = form.querySelector('#fixture-country');
      country.addEventListener('change', () => { country.dataset.changed = country.value; });
      form.querySelector('#fixture-file').addEventListener('change', (event) => {
        event.target.dataset.trusted = String(event.isTrusted);
      });
      return true;
    })()`);
    const picked = await toolJson("select_option", {
      selector: "#fixture-country",
      option: "France",
    });
    assert.deepEqual(
      picked.selected.map((option) => option.value),
      ["fr"],
      JSON.stringify(picked),
    );
    assert.equal(picked.changed, true);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-country').dataset.changed",
      ),
      "fr",
    );
    const byLocator = await toolJson("select_option", {
      locator: { attributes: [{ name: "id", value: "fixture-country" }] },
      option: "de",
    });
    assert.equal(byLocator.selected[0].label, "Germany");
    const unchanged = await toolJson("select_option", {
      selector: "#fixture-country",
      option: "Germany",
    });
    assert.equal(unchanged.changed, false);
    const both = await toolJson("select_option", {
      selector: "#fixture-langs",
      options: ["English", "de"],
    });
    assert.deepEqual(
      both.selected.map((option) => option.value),
      ["en", "de"],
    );
    const noSuchOption = await toolError("select_option", {
      selector: "#fixture-country",
      option: "Mars",
    });
    assert.match(noSuchOption.message, /No option matches.*Germany/s);
    const notSelect = await toolError("select_option", {
      selector: "#fixture-button",
      option: "x",
    });
    assert.match(notSelect.message, /not a <select>/);

    const uploaded = await toolJson("file_upload", {
      selector: "#fixture-upload-label",
      files: [{ name: "notes.txt", text: "Donut upload" }],
    });
    assert.deepEqual(uploaded.files, [{ name: "notes.txt", bytes: 12 }]);
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-file').files[0].text()",
      ),
      "Donut upload",
    );
    assert.equal(
      await cdp.evaluate(
        "document.querySelector('#fixture-file').dataset.trusted",
      ),
      "true",
      "the page sees the files arrive as a person's pick",
    );
    const replaced = await toolJson("file_upload", {
      selector: "#fixture-file",
      files: [
        {
          name: "bytes.bin",
          content_base64: Buffer.from([0, 1, 2]).toString("base64"),
        },
      ],
    });
    assert.deepEqual(replaced.files, [{ name: "bytes.bin", bytes: 3 }]);
    const stagedUploads = path.join(
      app.dataRoot,
      "cache",
      "agent-uploads",
      profile.id,
    );
    assert.equal(existsSync(stagedUploads), true);
    const oneFileOnly = await toolError("file_upload", {
      selector: "#fixture-file",
      files: [
        { name: "a.txt", text: "a" },
        { name: "b.txt", text: "b" },
      ],
    });
    assert.match(oneFileOnly.message, /takes one file/);

    // Network capture: what the page fetches, with its bodies and without its
    // credentials, and nothing while the person holds the profile.
    const capture = await toolJson("start_network_capture");
    assert.equal(capture.capturing, true, JSON.stringify(capture));
    assert.ok(capture.tabs >= 1, JSON.stringify(capture));
    assert.equal(
      (await toolJson("start_network_capture")).already_running,
      true,
    );
    const echoBody = JSON.stringify({ hello: "capture" });
    await cdp.evaluate(
      `fetch('/api/echo?capture=1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer e2e-secret' }, body: ${JSON.stringify(echoBody)} }).then((response) => response.text())`,
    );
    const echoed = await app.waitFor(
      async () => {
        const listed = await toolJson("list_network_requests", {
          url_contains: "/api/echo?capture=1",
        });
        const entry = listed.requests[0];
        return entry?.body === "kept" ? entry : null;
      },
      { timeoutMs: 10_000, description: "the captured echo request" },
    );
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.status, 200);
    assert.equal(echoed.type, "Fetch");
    const captured = await toolJson("get_network_request", {
      request_id: echoed.id,
    });
    assert.equal(captured.post_data, echoBody);
    assert.equal(JSON.parse(captured.body.text).body, echoBody);
    const header = (headers, name) =>
      Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    assert.equal(
      header(captured.request_headers, "authorization"),
      "[redacted]",
    );
    const setCookie = header(captured.response_headers, "set-cookie");
    assert.ok(setCookie === undefined || setCookie === "[redacted]", setCookie);
    const byBody = await toolJson("list_network_requests", {
      body_contains: "CAPTURE",
      type: "fetch",
    });
    assert.ok(
      byBody.requests.some((entry) => entry.id === echoed.id),
      JSON.stringify(byBody),
    );
    await app.invoke("take_over_profile", {
      profileId: profile.id,
      note: null,
    });
    await cdp.evaluate(
      "fetch('/api/echo?while-held=1').then((response) => response.text())",
    );
    // The capture reads the browser's events on its own task.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await app.invoke("hand_back_profile", {
      profileId: profile.id,
      note: null,
    });
    const whileHeld = await toolJson("list_network_requests", {
      url_contains: "while-held",
    });
    assert.equal(whileHeld.requests.length, 0, JSON.stringify(whileHeld));
    assert.ok(whileHeld.withheld >= 1, JSON.stringify(whileHeld));
    assert.equal((await toolJson("stop_network_capture")).stopped, true);
    assert.equal(
      (await toolError("list_network_requests")).data.code,
      "NETWORK_CAPTURE_NOT_RUNNING",
    );
    // Left running, so the browser's stop is what ends it.
    await toolJson("start_network_capture");

    const shot = await tool("screenshot");
    assert.equal(shot.mimeType, "image/jpeg");
    const jpeg = Buffer.from(shot.data, "base64");
    assert.equal(jpeg.readUInt16BE(0), 0xffd8, "a JPEG by default");

    const visited = await tool("navigate", { url: `${fixtureUrl}/again` });
    assert.match(visited.text, /Page: Donut E2E Browser Fixture <.*\/again>/);

    // A running browser is taken over as it is: a second run hands back the
    // same DevTools port with the URL in a new tab, and never restarts it.
    const takeover = await request(`${base}/v1/profiles/${profile.id}/run`, {
      method: "POST",
      token: saved.api_token,
      body: { url: `${fixtureUrl}/taken-over` },
    });
    assert.equal(takeover.response.status, 200, JSON.stringify(takeover.value));
    assert.equal(takeover.value.attached, true);
    assert.equal(
      takeover.value.remote_debugging_port,
      launched.value.remote_debugging_port,
    );
    const listed = await toolJson("list_tabs");
    const takenTab = listed.tabs.find((tab) => tab.url.endsWith("/taken-over"));
    assert.ok(takenTab, JSON.stringify(listed));
    assert.equal(
      takenTab.selected,
      true,
      "the new tab is the one the tools drive",
    );
    const otherTab = listed.tabs.find((tab) => tab.id !== takenTab.id);
    const switched = await toolJson("switch_tab", { tab_id: otherTab.id });
    assert.equal(switched.selected, true);
    assert.match((await tool("get_page_info")).text, /again/);
    await tool("close_tab", { tab_id: takenTab.id });
    assert.equal(
      (await toolJson("list_tabs")).tabs.some((tab) => tab.id === takenTab.id),
      false,
    );

    const runningProfile = (await app.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    browserPid = runningProfile.process_id;
    assert.equal(
      await app.invoke("check_browser_status", { profile: runningProfile }),
      true,
    );
    assertIdleResourceBounds(browserPid);
    if (process.platform !== "win32") {
      const command = execFileSync(
        "ps",
        ["-ww", "-o", "command=", "-p", String(browserPid)],
        {
          encoding: "utf8",
        },
      );
      assert.match(
        command,
        new RegExp(app.dataRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      // An automation run starts clean: it never reopens a person's session.
      // The crash-restore bubble stays hidden, and the retired switch that
      // Chromium no longer reads is gone from the command line.
      assert.doesNotMatch(command, /--restore-last-session/);
      assert.match(command, /--hide-crash-restore-bubble/);
      assert.doesNotMatch(command, /--disable-session-crashed-bubble/);
      assert.match(
        command,
        /--enable-logging=stderr/,
        "the browser's own verdicts reach the app through stderr",
      );
    }

    // The window's DevTools endpoint and network inspector reach the same
    // browser the automation port does, and the capture the agent left
    // running.
    const endpoint = await app.invoke("get_profile_debug_endpoint", {
      profileId: profile.id,
    });
    assert.equal(endpoint.port, launched.value.remote_debugging_port);
    assert.match(
      endpoint.ws_url,
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//,
    );
    const windowCapture = await app.invoke("start_network_capture", {
      profileId: profile.id,
    });
    assert.equal(windowCapture.capturing, true);
    assert.equal(windowCapture.already_running, true);

    const opened = await request(`${base}/v1/profiles/${profile.id}/open-url`, {
      method: "POST",
      token: saved.api_token,
      body: { url: `${fixtureUrl}/opened-via-api` },
    });
    assert.equal(opened.response.status, 200);
    const openedTarget = await app.waitFor(
      async () => {
        const targets = await fetch(
          `http://127.0.0.1:${launched.value.remote_debugging_port}/json`,
        ).then((response) => response.json());
        return (
          targets.find(
            (target) =>
              target.type === "page" && target.url.includes("/opened-via-api"),
          ) ?? false
        );
      },
      { timeoutMs: 20_000, description: "API-opened Wayfern target" },
    );
    // The tab's document request starts before the tab exists as a target, so
    // the capture cannot see it; what the tab sends once it is open is
    // captured, under the tab's own id.
    const openedTab = await CdpClient.connect(
      launched.value.remote_debugging_port,
      { match: (target) => target.id === openedTarget.id },
    );
    try {
      await openedTab.evaluate(
        "fetch('/api/echo?from=opened-via-api').then((response) => response.text())",
      );
    } finally {
      openedTab.close();
    }
    const capturedRequest = await app.waitFor(
      async () => {
        const listed = await app.invoke("list_network_requests", {
          profileId: profile.id,
        });
        assert.equal(listed.capturing, true);
        return (
          listed.requests.find((item) =>
            item.url.includes("/api/echo?from=opened-via-api"),
          ) ?? false
        );
      },
      { timeoutMs: 20_000, description: "captured API-opened request" },
    );
    assert.equal(
      capturedRequest.tab,
      openedTarget.id,
      JSON.stringify(capturedRequest),
    );
    const capturedDetail = await app.invoke("get_network_request", {
      profileId: profile.id,
      requestId: capturedRequest.id,
    });
    assert.equal(capturedDetail.id, capturedRequest.id);
    assert.equal(typeof capturedDetail.request_headers, "object");

    const killed = await request(`${base}/v1/profiles/${profile.id}/kill`, {
      method: "POST",
      token: saved.api_token,
    });
    assert.equal(killed.response.status, 204);
    cdp.close();
    cdp = null;
    await waitForProcessExit(app, browserPid);
    assert.equal(
      existsSync(stagedUploads),
      false,
      "an agent's uploads go with the browser",
    );
    assert.equal(
      (await toolError("list_network_requests")).data.code,
      "NETWORK_CAPTURE_NOT_RUNNING",
    );
    assert.deepEqual(
      await app.invoke("list_network_requests", { profileId: profile.id }),
      { capturing: false },
    );
    assert.deepEqual(
      await app.invoke("stop_network_capture", { profileId: profile.id }),
      { stopped: false },
    );
    const stoppedProfile = (await app.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    assert.equal(
      await app.invoke("check_browser_status", { profile: stoppedProfile }),
      false,
    );
    assert.equal(
      await app.invoke("get_profile_debug_endpoint", { profileId: profile.id }),
      null,
    );

    const batchProfile = await createRealProfile(
      app,
      prepared.version,
      "Wayfern Batch Automation",
      // The fingerprint STRING, not the envelope `generate_sample_fingerprint`
      // returns it in. `WayfernConfig.fingerprint` is an `Option<String>`
      // (wayfern_manager.rs), so passing `sample` made the whole command fail
      // to deserialise with "invalid type: map, expected a string", before any
      // of the automation this test exists to check could run.
      sample.fingerprint,
    );
    const batchRun = await request(`${base}/v1/profiles/batch/run`, {
      method: "POST",
      token: saved.api_token,
      body: {
        profile_ids: [batchProfile.id],
        url: `${fixtureUrl}/batch`,
        headless: true,
        delay_ms: 0,
        concurrency: 1,
      },
    });
    assert.equal(batchRun.response.status, 200);
    // A whole supplied device becomes an identity plus overrides. The browser
    // refuses some override values and names each one; the launcher drops it
    // and launches again, so the batch launches.
    assert.equal(
      batchRun.value.results[0].ok,
      true,
      batchRun.value.results[0].error,
    );
    const batchCdp = await CdpClient.connect(
      batchRun.value.results[0].remote_debugging_port,
    );
    assert.equal(
      await batchCdp.waitFor("window.__fixtureReady === true"),
      true,
    );
    batchCdp.close();
    const batchStop = await request(`${base}/v1/profiles/batch/stop`, {
      method: "POST",
      token: saved.api_token,
      body: { profile_ids: [batchProfile.id] },
    });
    assert.equal(batchStop.response.status, 200);
    // Stopping is idempotent: a profile that never launched is already
    // stopped, so the batch endpoint reports success either way.
    assert.equal(
      batchStop.value.results[0].ok,
      true,
      `batch stop reported ${JSON.stringify(batchStop.value.results[0])}`,
    );

    // The recipe recorder's refusals, which are the whole contract a caller can
    // rely on without a paid browser: what it will not start on, and that an
    // idle recorder answers rather than throwing. The capture itself is a paid
    // browser feature and is tested where that feature lives.
    assert.deepEqual(await app.invoke("get_recipe_recording"), {
      profile_id: null,
      steps: [],
      recording: false,
    });
    assert.deepEqual(await app.invoke("stop_recipe_recording"), {
      profile_id: null,
      steps: [],
      recording: false,
    });
    assert.match(
      await app.invokeError("start_recipe_recording", {
        profileId: "00000000-0000-0000-0000-000000000000",
      }),
      /PROFILE_NOT_FOUND/,
    );
    assert.match(
      await app.invokeError("start_recipe_recording", {
        profileId: profile.id,
      }),
      /PROFILE_NOT_RUNNING/,
      "a recording needs a live browser to attach to",
    );

    // Export and import: a profile is moved to another machine as one archive
    // and comes back as a NEW profile, owing nothing to the machine that wrote
    // it. Exercised here because this is the suite with a real profile
    // directory to carry.
    const exportPath = path.join(app.dataRoot, "exported.donutprofile");
    const exported = await app.invoke("export_profile", {
      profileId: profile.id,
      destination: exportPath,
      includeData: true,
    });
    assert.equal(exported.profile_name, profile.name);
    assert.equal(exported.browser, "wayfern");
    assert.ok((await stat(exportPath)).size > 0);
    const archivePreview = await app.invoke("preview_profile_archive", {
      path: exportPath,
    });
    assert.equal(archivePreview.manifest.profile_name, profile.name);
    assert.deepEqual(archivePreview.tags, []);
    const importedProfile = await app.invoke("import_profile_archive", {
      path: exportPath,
    });
    assert.notEqual(importedProfile.id, profile.id);
    assert.equal(importedProfile.version, profile.version);
    assert.equal(
      importedProfile.process_id,
      null,
      "an imported profile is not running on this machine",
    );
    assert.equal(
      importedProfile.proxy_id ?? null,
      null,
      "a proxy id belongs to the machine that assigned it",
    );
    assert.equal(
      importedProfile.wayfern_config.identity_id,
      profile.wayfern_config.identity_id,
      "the device travels: the same identity rebuilds the same browser",
    );
    // Twice from one archive gives two profiles, under distinct names.
    const importedAgain = await app.invoke("import_profile_archive", {
      path: exportPath,
    });
    assert.notEqual(importedAgain.id, importedProfile.id);
    assert.notEqual(importedAgain.name, importedProfile.name);
    assert.match(
      await app.invokeError("preview_profile_archive", {
        path: path.join(app.dataRoot, "not-an-archive"),
      }),
      /PROFILE_IMPORT_FAILED/,
    );
    for (const created of [importedProfile, importedAgain]) {
      await app.invoke("delete_profile", {
        profileId: created.id,
        permanent: true,
      });
    }

    // A temporary profile: created over REST for one run, gone once its
    // browser stops. Nothing else in the app removes it, so this is the
    // whole contract an automation client depends on.
    const temporary = await request(`${base}/v1/profiles`, {
      method: "POST",
      token: saved.api_token,
      body: {
        name: "Temporary Run",
        browser: "wayfern",
        version: prepared.version,
        temporary: true,
        tags: ["e2e-rest-tag"],
      },
    });
    assert.equal(
      temporary.response.status,
      200,
      JSON.stringify(temporary.value),
    );
    // Tags given on create are stored, not only echoed: the handler once
    // looked the new profile up by name where an id was needed, and every
    // create with tags answered 500.
    const storedTemporary = await request(
      `${base}/v1/profiles/${temporary.value.profile.id}`,
      { token: saved.api_token },
    );
    assert.deepEqual(storedTemporary.value.profile.tags, ["e2e-rest-tag"]);
    assert.equal(temporary.value.profile.temporary, true);
    assert.equal(
      temporary.value.profile.ephemeral,
      true,
      "a temporary profile keeps its browsing data in memory only",
    );
    const temporaryId = temporary.value.profile.id;
    const temporaryRun = await request(
      `${base}/v1/profiles/${temporaryId}/run`,
      {
        method: "POST",
        token: saved.api_token,
        body: { url: `${fixtureUrl}/temporary`, headless: true },
      },
    );
    assert.equal(
      temporaryRun.response.status,
      200,
      JSON.stringify(temporaryRun.value),
    );
    const temporaryPid = (await app.invoke("list_browser_profiles")).find(
      (item) => item.id === temporaryId,
    )?.process_id;
    assert.ok(
      temporaryPid,
      "the temporary profile must report the browser it started",
    );
    // The browser runs from the profile's RAM directory, and the tools must
    // find it there: they once looked only under the profiles dir.
    const ephemeralPage = await mcp("tools/call", {
      name: "get_page_info",
      arguments: { profile_id: temporaryId },
    });
    assert.notEqual(ephemeralPage.isError, true, JSON.stringify(ephemeralPage));
    assert.match(ephemeralPage.content[0].text, /temporary/);
    await request(`${base}/v1/profiles/${temporaryId}/kill`, {
      method: "POST",
      token: saved.api_token,
    });
    await waitForProcessExit(app, temporaryPid);
    await app.waitFor(
      async () =>
        !(await app.invoke("list_browser_profiles")).some(
          (item) => item.id === temporaryId,
        ),
      { description: "the temporary profile to delete itself" },
    );
    assert.deepEqual(
      (await app.invoke("list_trashed_profiles")).filter(
        (entry) => entry.id === temporaryId,
      ),
      [],
      "a disposable profile must not land in the trash",
    );

    await app.invoke("stop_api_server");
    await app.invoke("delete_profile", { profileId: profile.id });
    await app.invoke("delete_profile", { profileId: batchProfile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    cdp?.close();
    if (app.session && browserPid && processExists(browserPid)) {
      const profile = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (profile)
        await app.invoke("kill_browser_profile", { profile }).catch(() => {});
    }
    await app.close();
    assert.deepEqual(
      await snapshotFile(realTermsFile),
      realTermsBefore,
      "the browser suite modified the real Wayfern terms marker",
    );
  }
});

// What MCP agents reported on real forms, on a local page that has each kind
// of field: a locator by id finds a search input and a search textarea, a click
// lands on what a person sees (a radio drawn by its label, a day cell, a
// textarea beside a fixed banner, never the banner), a name that two fields
// share settles on the exact one, and typing either leaves the text in the
// field, through the input events a framework listens to, or fails and says so.
test("MCP locators and typing act on the field a person sees", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-mcp-forms", {
    seedVersionCache: localWayfernVersion ?? false,
    wayfernTermsAccepted: false,
  });
  let cdp;
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    if (!(await app.invoke("check_wayfern_terms_accepted"))) {
      await app.invoke("accept_wayfern_terms");
    }
    const profile = await createRealProfile(app, prepared.version, "MCP Forms");
    const settings = await app.invoke("get_app_settings");
    const saved = await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        api_enabled: true,
        api_port: 0,
        api_token: null,
        onboarding_completed: true,
      },
    });
    const port = await app.invoke("start_api_server", { port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const launched = await request(`${base}/v1/profiles/${profile.id}/run`, {
      method: "POST",
      token: saved.api_token,
      body: { url: `${fixtureUrl}/mcp-forms`, headless: true },
    });
    assert.equal(launched.response.status, 200, JSON.stringify(launched.value));
    browserPid = (await app.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    )?.process_id;
    cdp = await CdpClient.connect(launched.value.remote_debugging_port);
    await cdp.waitFor("window.__formsReady === true", {
      description: "the MCP forms fixture",
    });
    const { tool, toolJson, toolError } = await mcpClient(
      base,
      saved.api_token,
      profile.id,
    );
    const valueOf = (selector) =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
    const byId = (id) => ({ attributes: [{ name: "id", value: id }] });

    // An id the browser's own index does not carry: a search input and a
    // search textarea.
    const searched = await toolJson("type_locator", {
      locator: byId("searchInput"),
      text: "Donut Browser",
    });
    assert.equal(searched.typed, true, JSON.stringify(searched));
    assert.equal(searched.verified, true, JSON.stringify(searched));
    assert.equal(await valueOf("#searchInput"), "Donut Browser");
    const asked = await toolJson("type_locator", {
      locator: byId("sb_form_q"),
      text: "weather today",
    });
    assert.equal(asked.verified, true, JSON.stringify(asked));
    assert.equal(await valueOf("#sb_form_q"), "weather today");

    // A controlled field keeps only what real input events gave it: a value
    // assigned by a script is put back on the next render.
    const controlled = await toolJson("type_locator", {
      locator: { role: "textbox", name: "Full name" },
      text: "Jane Doe",
    });
    assert.equal(controlled.verified, true, JSON.stringify(controlled));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await valueOf("#react-name"), "Jane Doe");
    assert.equal(
      await cdp.evaluate("document.querySelector('#react-name').dataset.state"),
      "Jane Doe",
      "the page's own state took the text",
    );
    // Replaced, not appended, and still through input events.
    assert.match(
      (
        await tool("type_text", {
          selector: "#react-name",
          text: "John Roe",
        })
      ).text,
      /the field holds the text/,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await valueOf("#react-name"), "John Roe");
    assert.equal(
      await cdp.evaluate("document.querySelector('#react-name').dataset.state"),
      "John Roe",
    );

    // An autocomplete whose input is transparent and one pixel wide: the click
    // goes to its control, and the text reaches the input.
    const subject = await toolJson("type_locator", {
      locator: byId("subjectsInput"),
      text: "Mat",
    });
    assert.equal(subject.verified, true, JSON.stringify(subject));
    assert.equal(await valueOf("#subjectsInput"), "Mat");
    assert.match(
      await cdp.evaluate(
        "document.querySelector('#subjects-menu').textContent",
      ),
      /Maths/,
    );
    const batch = await toolJson("run_actions", {
      actions: [
        {
          tool: "type_text",
          arguments: { selector: "#subjectsInput", text: "Phy" },
        },
      ],
    });
    assert.equal(batch.completed, 1, JSON.stringify(batch));
    assert.equal(await valueOf("#subjectsInput"), "Phy");

    // Two names that differ by a suffix: the exact one is meant, and a
    // locator that really is ambiguous says what it matched.
    const first = await toolJson("type_locator", {
      locator: { nameContains: "First Name" },
      text: "Ada",
    });
    assert.equal(first.match.name, "First Name", JSON.stringify(first));
    assert.equal(await valueOf("#first-name"), "Ada");
    assert.equal(await valueOf("#first-name-optional"), "");
    const ambiguous = await toolError("resolve_locator", {
      locator: { role: "textbox", nameContains: "First" },
    });
    assert.equal(ambiguous.data.code, "LOCATOR_AMBIGUOUS");
    assert.deepEqual(
      ambiguous.data.candidates.map((candidate) => candidate.name).sort(),
      ["First Name", "First Name (optional)"],
    );
    assert.match(ambiguous.message, /First Name \(optional\)/);

    // Radios drawn by their labels: a text locator matches the label, a role
    // and name locator matches the radio, and both click through the label.
    const checked = () =>
      cdp.evaluate("document.querySelector('input[name=gender]:checked')?.id");
    const female = await toolJson("click_locator", {
      locator: { text: "Female" },
    });
    assert.equal(female.clicked, true, JSON.stringify(female));
    assert.equal(await checked(), "gender-radio-2");
    await toolJson("click_locator", {
      locator: { role: "radio", name: "Male" },
    });
    assert.equal(await checked(), "gender-radio-1");

    // A day cell of a date grid.
    await toolJson("click_locator", { locator: { text: "18" } });
    assert.equal(
      await cdp.evaluate("document.querySelector('#days').dataset.picked"),
      "18",
    );

    // A field the page will not change: typing fails, and says what it holds.
    const locked = await toolError("type_locator", {
      locator: byId("locked"),
      text: "nothing changes",
    });
    assert.equal(locked.data.code, "TYPE_NOT_APPLIED", JSON.stringify(locked));
    assert.equal(locked.data.reason, "value");
    assert.match(locked.message, /holds nothing/);

    // A textarea at the bottom of the window, half under a fixed banner: the
    // click and the typing land on the textarea, never on the banner.
    const underBanner = `(() => {
      const box = document.querySelector('#currentAddress').getBoundingClientRect();
      window.scrollBy(0, box.top - (window.innerHeight - 140));
      document.activeElement?.blur();
      return true;
    })()`;
    await cdp.evaluate(underBanner);
    await toolJson("click_locator", { locator: byId("currentAddress") });
    assert.equal(
      await cdp.evaluate("document.activeElement?.id"),
      "currentAddress",
    );
    await cdp.evaluate(underBanner);
    const address = await toolJson("type_locator", {
      locator: { role: "textbox", name: "Current Address" },
      text: "221B Baker Street",
    });
    assert.equal(address.verified, true, JSON.stringify(address));
    assert.equal(await valueOf("#currentAddress"), "221B Baker Street");
    assert.equal(
      await cdp.evaluate("document.querySelector('#fixedban').dataset.clicks"),
      undefined,
      "nothing struck the banner",
    );

    // By index from a listing, with the same read-back.
    const listing = (await tool("get_interactive_elements")).text;
    const line = listing
      .split("\n")
      .find((entry) => entry.includes('id="sb_form_q"'));
    const elementId = /^\[\d+ (e\d+)/.exec(line ?? "")?.[1];
    assert.ok(elementId, listing);
    assert.match(
      (
        await tool("type_by_index", {
          element_id: elementId,
          text: "by index",
        })
      ).text,
      /the field holds the text/,
    );
    assert.equal(await valueOf("#sb_form_q"), "by index");

    await request(`${base}/v1/profiles/${profile.id}/kill`, {
      method: "POST",
      token: saved.api_token,
    });
    if (browserPid) await waitForProcessExit(app, browserPid);
    await app.invoke("stop_api_server");
    await app.invoke("delete_profile", { profileId: profile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    cdp?.close();
    if (app.session && browserPid && processExists(browserPid)) {
      const running = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (running)
        await app
          .invoke("kill_browser_profile", { profile: running })
          .catch(() => {});
    }
    await app.close();
  }
});

/// Read every donut-proxy worker config the app has on disk.
async function readWorkerConfigs(app) {
  const dir = path.join(app.dataRoot, "cache", "proxy_workers");
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const configs = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      configs.push(JSON.parse(await readFile(path.join(dir, entry), "utf8")));
    } catch {
      // A worker rewriting its config mid-read is not a failure.
    }
  }
  return configs;
}

async function waitForCondition(check, description, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function assertWorkerRoute(port) {
  const target = new URL(fixtureUrl);
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(5_000, () =>
    socket.destroy(new Error("Proxy request timed out")),
  );
  const chunks = socket[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  const read = async (length) => {
    while (buffered.length < length) {
      const { value, done } = await chunks.next();
      assert.equal(done, false, "Proxy closed before its reply");
      buffered = Buffer.concat([buffered, value]);
    }
    const value = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return value;
  };
  try {
    socket.write(Buffer.from([5, 1, 0]));
    assert.deepEqual(await read(2), Buffer.from([5, 0]));
    const host = Buffer.from(target.hostname);
    const targetPort = Number(target.port || 80);
    socket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0, 3, host.length]),
        host,
        Buffer.from([targetPort >> 8, targetPort & 255]),
      ]),
    );
    assert.deepEqual(await read(4), Buffer.from([5, 0, 0, 1]));
    await read(6);
    socket.write(
      `GET /worker-recovery HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`,
    );
    const response = [buffered];
    for await (const chunk of chunks) response.push(chunk);
    assert.match(Buffer.concat(response).toString(), /^HTTP\/1\.1 200 /);
  } finally {
    socket.destroy();
  }
}

/// Launch a real profile and return it together with the worker serving it,
/// asserting the worker is pinned to that exact browser process.
async function launchWithWorker(app, version, name) {
  const profile = await createRealProfile(app, version, name);
  const launched = await app.invoke("launch_browser_profile", {
    profile,
    url: `${fixtureUrl}/worker-lifecycle`,
  });
  const browserPid = launched.process_id;
  assert.ok(browserPid, "Wayfern must report a process id");

  const worker = await app.waitFor(
    async () =>
      (await readWorkerConfigs(app)).find(
        (config) => config.profile_id === profile.id,
      ),
    { description: `the proxy worker config for ${name}` },
  );
  assert.ok(worker.pid, "the worker must record its own pid");
  assert.equal(
    worker.browser_pid,
    browserPid,
    "the worker must record the browser it serves",
  );
  // Without the start time a recycled PID reads as a live browser forever,
  // which is exactly how workers ended up outliving everything.
  assert.equal(
    typeof worker.browser_pid_start_time,
    "number",
    "the owning browser must be pinned to a start time, not just a pid",
  );
  return { profile, browserPid, workerPid: worker.pid, workerId: worker.id };
}

// The reported orphan, reproduced end to end with a real Wayfern. A detached
// donut-proxy has to notice its browser is gone and exit on its own — before it
// recorded a verified owner identity it just kept running and users killed it
// by hand. Phase one covers closing the browser; phase two covers the reported
// order (app closed first, so nothing is left to reap anything).
test("a proxy worker recovers for a live browser and dies with its browser", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-worker-lifecycle", {
    seedVersionCache: localWayfernVersion ?? false,
    // Let the app run the real acceptance flow below; the pre-seeded marker is
    // not what the Wayfern binary itself honours, and it would exit on launch.
    wayfernTermsAccepted: false,
    // The worker polls its owner every 15s in production; shorten it so a reap
    // is observable without padding the suite by minutes.
    extraEnv: { DONUT_PROXY_WATCHDOG_INTERVAL_MS: "500" },
  });

  const strays = new Set();
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    if (!(await app.invoke("check_wayfern_terms_accepted"))) {
      await app.invoke("accept_wayfern_terms");
    }

    // Phase one: the app is up, the browser goes away.
    const first = await launchWithWorker(app, prepared.version, "Worker Reap");
    strays.add(first.browserPid).add(first.workerPid);
    let worker = (await readWorkerConfigs(app)).find(
      (config) => config.id === first.workerId,
    );
    await assertWorkerRoute(worker.local_port);
    for (const afterRestart of [false, true]) {
      if (afterRestart) await app.restart();
      process.kill(worker.pid, "SIGKILL");
      await waitForCondition(
        () => !processExists(worker.pid),
        "failed worker to exit",
      );
      const recovered = await app.waitFor(
        async () => {
          const current = (await readWorkerConfigs(app)).find(
            (config) => config.id === worker.id,
          );
          return current?.pid !== worker.pid && processExists(current?.pid)
            ? current
            : false;
        },
        {
          timeoutMs: 45_000,
          description: "automatic proxy recovery on the original port",
        },
      );
      strays.add(recovered.pid);
      assert.deepEqual(recovered, { ...worker, pid: recovered.pid });
      assert.ok(
        processExists(first.browserPid),
        "recovery must keep the browser running",
      );
      await assertWorkerRoute(worker.local_port);
      worker = recovered;
    }
    first.workerPid = worker.pid;
    process.kill(first.browserPid, "SIGKILL");
    await waitForCondition(
      () => !processExists(first.browserPid),
      `Wayfern ${first.browserPid} to exit`,
    );
    await waitForCondition(
      () => !processExists(first.workerPid),
      `donut-proxy ${first.workerPid} to exit after its browser did`,
    );
    assert.equal(
      (await readWorkerConfigs(app)).find(
        (config) => config.id === first.workerId,
      ),
      undefined,
      "the worker must delete its config on the way out",
    );

    // Phase two: the reported order — close the app while the browser is still
    // running, then close the browser. Nothing but the worker is left alive.
    const second = await launchWithWorker(
      app,
      prepared.version,
      "Worker Reap After Quit",
    );
    strays.add(second.browserPid).add(second.workerPid);
    await app.close();

    // The app is expected to leave a live browser and its route alone on quit.
    // If the harness tears the session's whole process group down instead, the
    // orphan case cannot be observed here — say so rather than asserting on it.
    if (!processExists(second.browserPid) || !processExists(second.workerPid)) {
      console.warn(
        "Skipping the app-closed orphan check: the driver terminated the browser and/or worker along with the app",
      );
      return;
    }

    process.kill(second.browserPid, "SIGKILL");
    await waitForCondition(
      () => !processExists(second.browserPid),
      `Wayfern ${second.browserPid} to exit`,
    );
    await waitForCondition(
      () => !processExists(second.workerPid),
      `orphaned donut-proxy ${second.workerPid} to reap itself with no app running`,
    );
  } finally {
    for (const pid of strays) {
      if (pid && processExists(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await app.close();
  }
});

// Two things nothing else covers. First, that an assigned extension group
// actually reaches Wayfern: a loaded MV3 extension registers a
// `chrome-extension://<id>/background.js` service-worker target, so CDP can see
// it from outside. Second, that staging is per profile. It used to be one
// shared `extensions/unpacked` directory wiped on every launch, and because
// Chromium records the absolute staging path and reads those files lazily for
// the life of the process instead of copying them into the profile, launching a
// second profile broke the extension in every browser already running.
test("an assigned extension group reaches Wayfern and each profile stages its own copy", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-extensions", {
    seedVersionCache: localWayfernVersion ?? false,
    wayfernTermsAccepted: false,
  });
  const launched = [];
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    if (!(await app.invoke("check_wayfern_terms_accepted"))) {
      await app.invoke("accept_wayfern_terms");
    }

    const extension = await app.invoke("add_unpacked_extension", {
      name: "Donut Launch Fixture",
      path: await writeUnpackedExtension(
        path.join(app.root, "fixtures", "loaded-extension"),
        { name: "Donut Launch Fixture", version: "1.0.0" },
      ),
      link: false,
    });
    const group = await app.invoke("create_extension_group", {
      name: "Launch Extensions",
    });
    await app.invoke("add_extension_to_group", {
      groupId: group.id,
      extensionId: extension.id,
    });

    const settings = await app.invoke("get_app_settings");
    const saved = await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        api_enabled: true,
        api_port: 0,
        api_token: null,
        onboarding_completed: true,
      },
    });
    const base = `http://127.0.0.1:${await app.invoke("start_api_server", { port: 0 })}`;

    const stagedManifest = (profileId) =>
      path.join(
        app.dataRoot,
        "data",
        "extensions",
        "unpacked",
        profileId,
        extension.id,
        "manifest.json",
      );
    const extensionWorkers = async (debuggingPort) => {
      const targets = await fetch(
        `http://127.0.0.1:${debuggingPort}/json`,
      ).then((response) => response.json());
      return targets.filter(
        (target) =>
          target.type === "service_worker" &&
          String(target.url).startsWith("chrome-extension://"),
      );
    };
    const launchWithExtension = async (name) => {
      const profile = await createRealProfile(app, prepared.version, name);
      assert.equal(
        (
          await app.invoke("assign_extension_group_to_profile", {
            profileId: profile.id,
            extensionGroupId: group.id,
          })
        ).extension_group_id,
        group.id,
      );
      const run = await request(`${base}/v1/profiles/${profile.id}/run`, {
        method: "POST",
        token: saved.api_token,
        body: { url: `${fixtureUrl}/extension-launch`, headless: true },
      });
      assert.equal(run.response.status, 200, JSON.stringify(run.value));
      const record = {
        profile,
        debuggingPort: run.value.remote_debugging_port,
      };
      launched.push(record);
      const workers = await app.waitFor(
        async () => {
          const found = await extensionWorkers(record.debuggingPort);
          return found.length > 0 ? found : null;
        },
        {
          timeoutMs: 60_000,
          description: `the extension's service worker in ${name}`,
        },
      );
      assert.match(
        workers[0].url,
        /^chrome-extension:\/\/\w+\/background\.js$/,
      );
      return record;
    };

    const first = await launchWithExtension("Extension Launch One");
    assert.ok(
      existsSync(stagedManifest(first.profile.id)),
      "the first profile must stage the extension under its own id",
    );
    if (process.platform !== "win32") {
      // The staged path is what Chromium was handed, and it is per profile.
      const running = (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === first.profile.id,
      );
      const command = execFileSync(
        "ps",
        ["-ww", "-o", "command=", "-p", String(running.process_id)],
        { encoding: "utf8" },
      );
      assert.ok(
        command.includes(
          `--load-extension=${path.dirname(stagedManifest(first.profile.id))}`,
        ),
        "Wayfern must be pointed at this profile's own staged copy",
      );
    }
    await launchWithExtension("Extension Launch Two");

    // The regression itself: the second launch must not have taken the first
    // profile's files with it. The staged manifest is what its running browser
    // is still reading from.
    for (const { profile } of launched) {
      assert.ok(
        existsSync(stagedManifest(profile.id)),
        `${profile.name} lost its staged extension to another profile's launch`,
      );
    }

    for (const { profile } of launched) {
      const running = (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      );
      await app.invoke("kill_browser_profile", { profile: running });
      await waitForProcessExit(app, running.process_id);
    }
    await app.invoke("stop_api_server");
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    if (app.session) {
      const running = await app.invoke("list_browser_profiles").catch(() => []);
      for (const { profile } of launched) {
        const record = running.find((item) => item.id === profile.id);
        if (record?.process_id && processExists(record.process_id)) {
          await app
            .invoke("kill_browser_profile", { profile: record })
            .catch(() => {});
        }
      }
    }
    await app.close();
  }
});

/// The browser's remote-debugging port, read off its own command line: an
/// interactive launch does not hand the port back the way an API run does.
function debuggingPortOf(pid) {
  const command = execFileSync(
    "ps",
    ["-ww", "-o", "command=", "-p", String(pid)],
    { encoding: "utf8" },
  );
  const match = command.match(/--remote-debugging-port=(\d+)/);
  assert.ok(match, `no debugging port on the command line: ${command}`);
  return { port: Number(match[1]), command };
}

async function targetUrls(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
    r.json(),
  );
  return targets
    .filter((target) => target.type === "page")
    .map((target) => target.url);
}

test("an interactive launch continues the last session once the identity travels at launch", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-session", {
    seedVersionCache: localWayfernVersion ?? false,
    wayfernTermsAccepted: false,
  });
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    // The browser itself refuses to start until its terms marker exists, and
    // only its own acceptance run writes one it recognises.
    await app.invoke("accept_wayfern_terms");
    const major = Number.parseInt(prepared.version.split(".")[0], 10);
    if (major < 152) {
      // Older builds take no launch identity, so Donut starts them on a fresh
      // tab and there is nothing to continue.
      console.log(
        `[donut-e2e] Wayfern ${prepared.version} takes no launch identity; session restore is off by design, skipping the restore assertions`,
      );
      return;
    }

    const profile = await createRealProfile(
      app,
      prepared.version,
      "Session Restore",
    );
    // A launch identity needs the exit's timezone; the geoip match writes it.
    await app.invoke("download_geoip_database");
    await app.invoke("match_profile_fingerprint_to_exit", {
      profileId: profile.id,
      exitIp: "8.8.8.8",
    });
    const stored = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    const location = JSON.parse(stored.wayfern_config.location);
    assert.equal(typeof location.timezone, "string");
    const userDataDir = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
    );

    const launch = async (url) => {
      const current = (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );
      const launched = await app.invoke("launch_browser_profile", {
        profile: current,
        url,
      });
      assert.ok(launched.process_id);
      browserPid = launched.process_id;
      return launched;
    };
    const stop = async () => {
      const current = (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );
      await app.invoke("kill_browser_profile", { profile: current });
      await waitForProcessExit(app, browserPid);
    };
    const waitForTargets = async (port, expected) => {
      let seen = [];
      await app
        .waitFor(
          async () => {
            seen = await targetUrls(port).catch(() => []);
            return expected.every((needle) =>
              seen.some((url) => url.includes(needle)),
            );
          },
          { timeoutMs: 30_000, description: `targets ${expected.join(", ")}` },
        )
        .catch(() => {
          // The URLs it did see are the whole diagnosis: a restore that
          // dropped one tab looks identical to one that never ran.
          assert.fail(
            `waiting for ${expected.join(", ")} but the browser had ${
              seen.length ? seen.join(", ") : "no page targets"
            }`,
          );
        });
    };

    // First session: two tabs.
    const first = await launch(`${fixtureUrl}/session-a`);
    const { port: firstPort, command } = debuggingPortOf(first.process_id);
    assert.match(command, /--restore-last-session/);
    assert.match(command, /--wayfern-identity-file=/);
    const identityFile = JSON.parse(
      await readFile(path.join(userDataDir, "wayfern-identity.json"), "utf8"),
    );
    assert.equal(identityFile.identityId, stored.wayfern_config.identity_id);
    assert.equal(identityFile.timezone, location.timezone);
    // No claimed OS means the host, which is what an omitted operatingSystem
    // means over CDP as well; the document has to spell it out.
    assert.equal(
      identityFile.operatingSystem,
      stored.wayfern_config.os ?? currentHostOs(),
    );
    await waitForTargets(firstPort, ["/session-a"]);
    await app.invoke("open_url_with_profile", {
      profileId: profile.id,
      url: `${fixtureUrl}/session-b`,
    });
    await waitForTargets(firstPort, ["/session-a", "/session-b"]);
    await stop();
    const preferences = JSON.parse(
      await readFile(path.join(userDataDir, "Default", "Preferences"), "utf8"),
    );
    assert.equal(
      preferences.profile?.exit_type,
      "Normal",
      "a stop must run the browser's own shutdown so the session is written",
    );

    // Second session: both tabs come back, and the launch URL gets its own
    // tab instead of replacing a restored one.
    const second = await launch(`${fixtureUrl}/session-c`);
    const { port: secondPort } = debuggingPortOf(second.process_id);
    await waitForTargets(secondPort, [
      "/session-a",
      "/session-b",
      "/session-c",
    ]);

    // A browser that died hard still comes back, with no bubble to answer.
    // Chromium commits a tab change to the session file on a short delay, so a
    // kill in the same second loses the newest tab through no fault of the
    // launcher; wait for the write before pulling the plug.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    process.kill(second.process_id, "SIGKILL");
    await waitForProcessExit(app, second.process_id);
    await app.waitFor(
      async () =>
        !(await app.invoke("check_browser_status", {
          profile: (
            await app.invoke("list_browser_profiles")
          ).find((p) => p.id === profile.id),
        })),
      { description: "the app to notice the killed browser" },
    );
    const third = await launch(null);
    const { port: thirdPort } = debuggingPortOf(third.process_id);
    await waitForTargets(thirdPort, ["/session-a", "/session-b", "/session-c"]);
    await stop();

    // Switched off, the profile starts on a fresh tab.
    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: { ...stored.wayfern_config, restore_session: false },
    });
    const fourth = await launch(`${fixtureUrl}/session-d`);
    const { port: fourthPort, command: fourthCommand } = debuggingPortOf(
      fourth.process_id,
    );
    assert.doesNotMatch(fourthCommand, /--restore-last-session/);
    await waitForTargets(fourthPort, ["/session-d"]);
    assert.ok(
      !(await targetUrls(fourthPort)).some((url) => url.includes("/session-a")),
      "a profile with restore switched off must not reopen the old session",
    );
    await stop();
    await app.invoke("delete_profile", { profileId: profile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    if (app.session && browserPid && processExists(browserPid)) {
      const profile = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (profile)
        await app.invoke("kill_browser_profile", { profile }).catch(() => {});
    }
    await app.close();
  }
});

test("a payload profile an older version stored launches and is stored as an identity", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const localWayfernVersion = cachedFixtureVersion(
    process.env.DONUT_E2E_PROJECT_ROOT,
  );
  const app = appFromEnvironment("browser-legacy-payload", {
    seedVersionCache: localWayfernVersion ?? false,
    wayfernTermsAccepted: false,
  });
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    const major = Number.parseInt(prepared.version.split(".")[0], 10);
    if (major < 152) {
      console.log(
        `[donut-e2e] Wayfern ${prepared.version} converts no stored payload; skipping the legacy launch`,
      );
      return;
    }

    const profile = await createRealProfile(
      app,
      prepared.version,
      "Stored By 0.30",
    );

    // The file as v0.30 wrote it: the whole device payload, no identity, and
    // none of the fields added since. Its raw JSON never equals the profile it
    // parses to, and comparing the two raw once refused every launch of such
    // a profile as WAYFERN_BROWSER_BUSY.
    const metadataFile = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "metadata.json",
    );
    const stored = JSON.parse(await readFile(metadataFile, "utf8"));
    // Set, so listing the profiles never rewrites the file in the new shape.
    assert.equal(typeof stored.host_os, "string");
    delete stored.temporary;
    for (const key of [
      "webrtc_mode",
      "persona",
      "camera_file",
      "camera_crop",
      "restore_session",
      "identity_overrides",
      "location",
    ]) {
      delete stored.wayfern_config[key];
    }
    stored.wayfern_config.identity_id = null;
    stored.wayfern_config.fingerprint = JSON.stringify({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      platform: "MacIntel",
      vendor: "Google Inc.",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      screenWidth: 1512,
      screenHeight: 982,
      screenAvailWidth: 1512,
      screenAvailHeight: 944,
      screenColorDepth: 30,
      devicePixelRatio: 2,
      language: "en-US",
      languages: ["en-US", "en"],
      timezone: "Europe/Berlin",
      timezoneOffset: -120,
    });
    await writeFile(metadataFile, JSON.stringify(stored, null, 2));

    const legacy = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    assert.equal(legacy.wayfern_config.identity_id, null);
    const launched = await app.invoke("launch_browser_profile", {
      profile: legacy,
    });
    assert.ok(launched.process_id);
    browserPid = launched.process_id;

    const converted = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    assert.equal(
      typeof converted.wayfern_config.identity_id,
      "string",
      "the launch must store the payload profile as an identity",
    );
    assert.equal(
      converted.wayfern_config.fingerprint,
      undefined,
      "a converted profile must store no device payload",
    );
    await app.invoke("kill_browser_profile", { profile: converted });
    await waitForProcessExit(app, browserPid);
    await app.invoke("delete_profile", { profileId: profile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    if (app.session && browserPid && processExists(browserPid)) {
      const profile = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (profile)
        await app.invoke("kill_browser_profile", { profile }).catch(() => {});
    }
    await app.close();
  }
});

test("start pages open on a launch from the app, and a given URL replaces them", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const app = appFromEnvironment("browser-start-pages", {
    seedVersionCache:
      cachedFixtureVersion(process.env.DONUT_E2E_PROJECT_ROOT) ?? false,
    wayfernTermsAccepted: false,
  });
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    const profile = await createRealProfile(
      app,
      prepared.version,
      "Start Pages",
    );
    const one = `${fixtureUrl}/start-page-one`;
    const two = `${fixtureUrl}/start-page-two`;
    const withPages = await app.invoke("update_profile_start_urls", {
      profileId: profile.id,
      startUrls: [one, " ", two],
    });
    assert.deepEqual(withPages.start_urls, [one, two]);

    const openPages = async (pid) => {
      const port = processCommandLine(pid).match(
        /--remote-debugging-port=(\d+)/,
      )?.[1];
      if (!port) return [];
      const targets = await fetch(`http://127.0.0.1:${port}/json`)
        .then((response) => response.json())
        .catch(() => []);
      return targets
        .filter((target) => target.type === "page")
        .map((target) => target.url);
    };
    const stop = async () => {
      const current = (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );
      await app.invoke("kill_browser_profile", { profile: current });
      await waitForProcessExit(app, current.process_id);
      browserPid = undefined;
    };

    const launched = await app.invoke("launch_browser_profile", {
      profile: withPages,
    });
    browserPid = launched.process_id;
    const pages = await app.waitFor(
      async () => {
        const urls = await openPages(browserPid);
        return urls.includes(one) && urls.includes(two) ? urls : false;
      },
      { timeoutMs: 30_000, description: "both start pages open" },
    );
    assert.equal(pages.length, 2, `only the start pages: ${pages}`);
    await stop();

    const given = `${fixtureUrl}/given-url`;
    const relaunched = await app.invoke("launch_browser_profile", {
      profile: (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      ),
      url: given,
    });
    browserPid = relaunched.process_id;
    const replaced = await app.waitFor(
      async () => {
        const urls = await openPages(browserPid);
        return urls.includes(given) ? urls : false;
      },
      { timeoutMs: 30_000, description: "the given URL open" },
    );
    assert.ok(
      !replaced.includes(one) && !replaced.includes(two),
      `a given URL replaces the start pages: ${replaced}`,
    );
    await stop();
    await app.invoke("delete_profile", { profileId: profile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    if (app.session && browserPid && processExists(browserPid)) {
      const running = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (running)
        await app
          .invoke("kill_browser_profile", { profile: running })
          .catch(() => {});
    }
    await app.close();
  }
});

test("a batch from a template makes numbered profiles, each with its own device", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const app = appFromEnvironment("browser-template-batch", {
    seedVersionCache:
      cachedFixtureVersion(process.env.DONUT_E2E_PROJECT_ROOT) ?? false,
    wayfernTermsAccepted: false,
  });
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    // A profile that already holds the name, so numbering continues after it.
    await createRealProfile(app, prepared.version, "Real Batch 1");
    const template = await app.invoke("create_profile_template", {
      name: "Real",
      settings: {
        tags: ["batch"],
        start_urls: ["shop.example"],
        wayfern_config: {
          geoip: false,
          randomize_fingerprint_on_launch: false,
        },
      },
    });

    const result = await app.invoke("bulk_create_profiles", {
      settings: template.settings,
      name: "Real Batch",
      count: 2,
    });
    assert.equal(result.error, null);
    assert.equal(result.cancelled, false);
    assert.deepEqual(
      result.created.map((p) => p.name),
      ["Real Batch 2", "Real Batch 3"],
    );
    const stored = (await app.invoke("list_browser_profiles")).filter((p) =>
      result.created.some((made) => made.id === p.id),
    );
    assert.equal(stored.length, 2);
    for (const profile of stored) {
      assert.deepEqual(profile.tags, ["batch"]);
      assert.deepEqual(profile.start_urls, ["https://shop.example/"]);
      assert.equal(profile.version, prepared.version);
    }
    const devices = stored.map(
      (p) => p.wayfern_config?.identity_id ?? p.wayfern_config?.fingerprint,
    );
    assert.ok(devices.every(Boolean), "every profile got a device");
    assert.notEqual(devices[0], devices[1], "no two profiles share a device");

    for (const profile of await app.invoke("list_browser_profiles")) {
      await app.invoke("delete_profile", {
        profileId: profile.id,
        permanent: true,
      });
    }
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
  }
});

test("Local Storage that Donut writes, Wayfern reads, and what Wayfern writes exports", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const app = appFromEnvironment("browser-local-storage", {
    seedVersionCache:
      cachedFixtureVersion(process.env.DONUT_E2E_PROJECT_ROOT) ?? false,
    wayfernTermsAccepted: false,
  });
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    const profile = await createRealProfile(
      app,
      prepared.version,
      "Local Storage",
    );
    const origin = new URL(fixtureUrl).origin;
    const imported = await app.invoke("import_profile_storage_state", {
      profileId: profile.id,
      content: JSON.stringify({
        origins: [
          {
            origin,
            localStorage: [
              { name: "imported", value: "from Donut" },
              { name: "unicode", value: "日本語 🍩" },
            ],
            // Playwright's shape: a store with an in-line key and an index,
            // and one with out-of-line keys and an encoded (Date) value.
            indexedDB: [
              {
                name: "shop",
                version: 2,
                stores: [
                  {
                    name: "cart",
                    autoIncrement: false,
                    keyPath: "id",
                    records: [{ value: { id: 1, item: "donut" } }],
                    indexes: [
                      {
                        name: "by_item",
                        keyPath: "item",
                        multiEntry: false,
                        unique: false,
                      },
                    ],
                  },
                  {
                    name: "kv",
                    autoIncrement: false,
                    records: [
                      {
                        key: "when",
                        valueEncoded: { d: "2026-10-12T00:00:00.000Z" },
                      },
                    ],
                    indexes: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    assert.equal(imported.items, 2);
    assert.equal(imported.indexed_db_records, 2);

    const launched = await app.invoke("launch_browser_profile", {
      profile: (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      ),
      url: `${fixtureUrl}/local-storage`,
    });
    browserPid = launched.process_id;
    const port = processCommandLine(browserPid).match(
      /--remote-debugging-port=(\d+)/,
    )?.[1];
    assert.ok(port, "the launch exposes a debugging port");
    const cdp = await CdpClient.connect(Number(port));
    await cdp.waitFor(`location.pathname === "/local-storage"`, {
      description: "the fixture page",
    });
    assert.equal(
      await cdp.evaluate("localStorage.getItem('imported')"),
      "from Donut",
    );
    assert.equal(
      await cdp.evaluate("localStorage.getItem('unicode')"),
      "日本語 🍩",
    );
    await cdp.evaluate("localStorage.setItem('written', 'by Wayfern'); true");
    const inShop = (body) =>
      cdp.evaluate(`(async () => {
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open("shop");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const read = (store, key) => new Promise((resolve, reject) => {
          const get = db.transaction(store).objectStore(store).get(key);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        const result = await (${body})(db, read);
        db.close();
        return result;
      })()`);
    assert.equal(
      await inShop("async (db, read) => (await read('cart', 1)).item"),
      "donut",
    );
    assert.equal(
      await inShop(
        "async (db, read) => (await read('kv', 'when')) instanceof Date",
      ),
      true,
    );
    await inShop(`(db) => new Promise((resolve, reject) => {
      const tx = db.transaction("cart", "readwrite");
      tx.objectStore("cart").put({ id: 2, item: "cruller" });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })`);
    // Chromium commits Local Storage to disk a few seconds after a change.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    cdp.close?.();

    const running = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    await app.invoke("kill_browser_profile", { profile: running });
    await waitForProcessExit(app, browserPid);
    browserPid = undefined;

    const exported = JSON.parse(
      await app.invoke("export_profile_storage_state", {
        profileId: profile.id,
        includeCookies: false,
      }),
    );
    const site = exported.origins.find((o) => o.origin === origin);
    assert.ok(
      site,
      `the fixture origin is exported: ${JSON.stringify(exported.origins)}`,
    );
    const items = Object.fromEntries(
      site.localStorage.map((i) => [i.name, i.value]),
    );
    assert.equal(items.imported, "from Donut");
    assert.equal(items.written, "by Wayfern");
    assert.equal(site.indexedDB, undefined, "IndexedDB only when asked for");

    // With IndexedDB the closed profile opens headless for a moment.
    const withDatabases = JSON.parse(
      await app.invoke("export_profile_storage_state", {
        profileId: profile.id,
        includeCookies: false,
        includeIndexedDb: true,
      }),
    );
    const shop = withDatabases.origins
      .find((o) => o.origin === origin)
      ?.indexedDB?.find((db) => db.name === "shop");
    assert.ok(shop, JSON.stringify(withDatabases.origins));
    assert.equal(shop.version, 2);
    const cart = shop.stores.find((store) => store.name === "cart");
    assert.equal(cart.keyPath, "id");
    assert.deepEqual(cart.records.map((record) => record.value.item).sort(), [
      "cruller",
      "donut",
    ]);
    assert.equal(cart.indexes[0].name, "by_item");
    const kv = shop.stores.find((store) => store.name === "kv");
    assert.deepEqual(kv.records, [
      { key: "when", valueEncoded: { d: "2026-10-12T00:00:00.000Z" } },
    ]);
    assert.equal(
      (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      ).process_id,
      null,
      "the headless browser is closed again",
    );
    await app.invoke("delete_profile", {
      profileId: profile.id,
      permanent: true,
    });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    if (app.session && browserPid && processExists(browserPid)) {
      const running = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (running)
        await app
          .invoke("kill_browser_profile", { profile: running })
          .catch(() => {});
    }
    await app.close();
  }
});

test("custom launch arguments reach only their Wayfern profile", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const app = appFromEnvironment("browser-launch-args", {
    seedVersionCache:
      cachedFixtureVersion(process.env.DONUT_E2E_PROJECT_ROOT) ?? false,
    wayfernTermsAccepted: false,
  });
  let cdp;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    const profile = await createRealProfile(
      app,
      prepared.version,
      "Launch Arguments",
    );
    const other = await createRealProfile(
      app,
      prepared.version,
      "Default Arguments",
    );
    const custom = [
      "--mute-audio",
      "--disable-gpu",
      "--renderer-process-limit=4",
      "--disable-features=DonutLaunchArgsTest",
    ];
    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: { ...profile.wayfern_config, launch_args: custom },
    });
    const stored = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    const settings = await app.invoke("get_app_settings");
    const savedSettings = await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        api_enabled: true,
        api_port: 0,
        api_token: null,
      },
    });
    const port = await app.invoke("start_api_server", { port: 0 });
    const launch = async () => {
      const result = await request(
        `http://127.0.0.1:${port}/v1/profiles/${profile.id}/run`,
        {
          method: "POST",
          token: savedSettings.api_token,
          body: { url: "about:blank", headless: true },
        },
      );
      assert.equal(result.response.status, 200, JSON.stringify(result.value));
      return result.value;
    };
    const stop = async () => {
      const current = (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );
      await app.invoke("kill_browser_profile", { profile: current });
      await waitForProcessExit(app, current.process_id);
    };
    const launched = await launch();
    cdp = await CdpClient.connect(launched.remote_debugging_port);
    const running = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    // Browser.getBrowserCommandLine needs --enable-automation, which a profile
    // may not set, so the OS command line is what is checked.
    const processArgs = processCommandLine(running.process_id);
    for (const argument of custom.filter(
      (arg) => !arg.startsWith("--disable-features="),
    )) {
      assert.ok(processArgs.includes(argument), argument);
    }
    const disabled = processArgs.match(/--disable-features=(\S+)/g) ?? [];
    assert.equal(disabled.length, 1, "one merged --disable-features switch");
    assert.ok(disabled[0].includes("DonutLaunchArgsTest"));
    assert.ok(disabled[0].includes("AsyncDns"));
    assert.ok(disabled[0].includes("Prefetch"));
    assert.ok(
      processArgs.includes(
        `--user-data-dir=${path.join(app.dataRoot, "data", "profiles", profile.id, "profile")}`,
      ),
    );
    assert.match(
      await app.invokeError("update_wayfern_config", {
        profileId: profile.id,
        config: { ...stored.wayfern_config, launch_args: [] },
      }),
      /running|PROFILE_RUNNING/i,
    );
    cdp.close();
    cdp = null;
    await stop();
    assert.deepEqual(
      (await app.invoke("list_browser_profiles")).find((p) => p.id === other.id)
        .wayfern_config.launch_args ?? [],
      [],
    );

    await app.invoke("update_wayfern_config", {
      profileId: profile.id,
      config: {
        ...stored.wayfern_config,
        launch_args: ["--mute-audio"],
      },
    });
    const relaunched = await launch();
    cdp = await CdpClient.connect(relaunched.remote_debugging_port);
    const current = (await app.invoke("list_browser_profiles")).find(
      (p) => p.id === profile.id,
    );
    assert.ok(
      !processCommandLine(current.process_id).includes("--disable-gpu"),
    );
    assert.ok(processCommandLine(current.process_id).includes("--mute-audio"));
    cdp.close();
    cdp = null;
    await stop();
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    cdp?.close();
    if (app.session) {
      const profiles = await app
        .invoke("list_browser_profiles")
        .catch(() => []);
      for (const profile of profiles.filter((p) => p.process_id)) {
        await app.invoke("kill_browser_profile", { profile }).catch(() => {});
      }
    }
    await app.close();
  }
});

test("a password-protected profile keeps what each session saved", async () => {
  assert.ok(process.env.WAYFERN_TEST_TOKEN, "WAYFERN_TEST_TOKEN is required");
  const app = appFromEnvironment("browser-sealed", {
    seedVersionCache:
      cachedFixtureVersion(process.env.DONUT_E2E_PROJECT_ROOT) ?? false,
    wayfernTermsAccepted: false,
  });
  const password = "sealed-sessions";
  let cdp;
  let browserPid;
  try {
    const prepared = await prepareWayfern(
      app,
      process.env.DONUT_E2E_PROJECT_ROOT,
    );
    if (!app.session) await app.start();
    await app.invoke("accept_wayfern_terms");
    const profile = await createRealProfile(
      app,
      prepared.version,
      "Sealed Sessions",
    );
    await app.invoke("set_profile_password", {
      profileId: profile.id,
      password,
    });
    const sealedDir = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
    );
    const current = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (p) => p.id === profile.id,
      );

    const saved = [];
    for (let session = 0; session < 3; session++) {
      if (await app.invoke("is_profile_locked", { profileId: profile.id })) {
        await app.invoke("unlock_profile", { profileId: profile.id, password });
      }
      const launched = await app.invoke("launch_browser_profile", {
        profile: await current(),
        url: `${fixtureUrl}/sealed`,
      });
      browserPid = launched.process_id;
      const port = Number(
        processCommandLine(browserPid).match(
          /--remote-debugging-port=(\d+)/,
        )[1],
      );
      cdp = await CdpClient.connect(port);
      await cdp.waitFor(`document.title === "Donut E2E Browser Fixture"`, {
        description: "fixture page title",
      });
      const cookies = await cdp.evaluate("document.cookie");
      for (const name of saved) {
        assert.match(
          cookies,
          new RegExp(`${name}=kept`),
          `session ${session} lost the cookie session ${name} saved`,
        );
      }
      const name = `sealed_${session}`;
      await cdp.evaluate(
        `document.cookie = "${name}=kept; Max-Age=86400; Path=/"`,
      );
      saved.push(name);
      cdp.close();
      cdp = null;

      // The cookie store commits every 30 s or at a clean shutdown, and a
      // browser asked to close in its first seconds does not shut down.
      await new Promise((resolve) => setTimeout(resolve, 32_000));
      await app.invoke("kill_browser_profile", { profile: await current() });
      await waitForProcessExit(app, browserPid);
      browserPid = null;
      assert.equal(
        await app.invoke("is_profile_locked", { profileId: profile.id }),
        true,
        "a quit is sealed and its key forgotten before Stop returns",
      );
      const names = await readdir(sealedDir);
      assert.ok(
        names.every((n) => /^[\w-]{32}$/.test(n) || n === ".donut-pw-verify"),
        `only sealed files belong in the profile directory: ${names}`,
      );
    }

    const logDir = path.join(app.dataRoot, "logs");
    const logText = (
      await Promise.all(
        (
          await readdir(logDir)
        )
          .filter((n) => n.endsWith(".log"))
          .map((n) => readFile(path.join(logDir, n), "utf8")),
      )
    ).join("\n");
    assert.doesNotMatch(logText, /Cookie decryption check failed/);
    assert.doesNotMatch(logText, /Profile re-encryption failed/);
    assert.equal(
      logText.match(
        new RegExp(`Profile re-encrypted profile=${profile.id} `, "g"),
      )?.length,
      3,
      "each quit is sealed exactly once",
    );
    await app.invoke("delete_profile", { profileId: profile.id });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    cdp?.close();
    if (app.session && browserPid && processExists(browserPid)) {
      const profile = (
        await app.invoke("list_browser_profiles").catch(() => [])
      ).find((item) => item.process_id === browserPid);
      if (profile)
        await app.invoke("kill_browser_profile", { profile }).catch(() => {});
    }
    await app.close();
  }
});
