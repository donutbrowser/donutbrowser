import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appFromEnvironment } from "../lib/app.mjs";
import { extensionZipBase64, wireGuardFixture } from "../lib/fixtures.mjs";

const syncUrl = process.env.DONUT_E2E_SYNC_URL;
const syncToken = process.env.DONUT_E2E_SYNC_TOKEN;

async function syncRequest(endpoint, body) {
  const response = await fetch(`${syncUrl}/v1/objects/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${syncToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Sync ${endpoint} failed with HTTP ${response.status}: ${text}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function listRemote(prefix = "") {
  const result = await syncRequest("list", {
    prefix,
    maxKeys: 1000,
    continuationToken: null,
  });
  return result.objects;
}

async function downloadRemote(key) {
  const presigned = await syncRequest("presign-download", {
    key,
    expiresIn: 300,
  });
  const response = await fetch(presigned.url);
  assert.equal(response.status, 200, `Could not download remote object ${key}`);
  return Buffer.from(await response.arrayBuffer());
}

async function configureSync(app) {
  const saved = await app.invoke("save_sync_settings", {
    syncServerUrl: syncUrl,
    syncToken,
  });
  assert.equal(saved.sync_server_url, syncUrl);
  assert.equal(saved.sync_token, syncToken);
  assert.deepEqual(await app.invoke("get_sync_settings"), saved);
  await app.invoke("restart_sync_service");
  await new Promise((resolve) => setTimeout(resolve, 750));
  // The header indicator reads this once; null until the first pass ran.
  const health = await app.invoke("get_sync_health");
  assert.ok(
    health === null ||
      ["idle", "syncing", "offline", "error"].includes(health.state),
    `sync health must be a known state, got ${JSON.stringify(health)}`,
  );
}

async function createProfile(app, name) {
  return app.invoke("create_browser_profile_new", {
    name,
    browserStr: "wayfern",
    version: "150.0.7871.100",
    releaseType: "stable",
    proxyId: null,
    vpnId: null,
    // Keep sync tests deterministic and network-free; browser.test.mjs covers
    // generation through the real Wayfern binary.
    wayfernConfig: { fingerprint: "{}" },
    groupId: null,
    ephemeral: false,
    dnsBlocklist: null,
    launchHook: null,
  });
}

async function waitFor(app, callback, description, timeoutMs = 45_000) {
  return app.waitFor(callback, { description, timeoutMs, intervalMs: 250 });
}

test("remote profile changes return after a long outage without another app restart", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const app = appFromEnvironment("sync-remote-return");
  let mode = "missing";
  let profileId;
  let missingManifests = 0;
  let failedPulls = 0;
  let failedFiles = 0;
  let proxyUrl;
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const input = body ? JSON.parse(body) : {};
      if (request.url === "/failed-file") {
        failedFiles += 1;
        response.writeHead(503).end();
        return;
      }
      if (request.url.endsWith("/subscribe")) {
        response.writeHead(503).end();
        return;
      }
      if (mode === "offline") {
        if (input.key === `profiles/${profileId}/metadata.json`) {
          failedPulls += 1;
        }
        response.writeHead(503).end();
        return;
      }
      if (
        mode === "missing" &&
        request.url.endsWith("/stat") &&
        input.key === `profiles/${profileId}/manifest.json`
      ) {
        missingManifests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ exists: false }));
        return;
      }
      const upstream = await fetch(`${syncUrl}${request.url}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${syncToken}`,
          "content-type": "application/json",
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      let text = await upstream.text();
      if (
        mode === "partial" &&
        request.url.endsWith("/presign-download-batch")
      ) {
        const result = JSON.parse(text);
        for (const item of result.items ?? []) {
          if (item.key.endsWith("/History"))
            item.url = `${proxyUrl}/failed-file`;
        }
        text = JSON.stringify(result);
      }
      response.writeHead(upstream.status, {
        "content-type": "application/json",
      });
      response.end(text);
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  try {
    await app.start();
    await configureSync(app);
    const profile = await createProfile(app, "Remote Return");
    profileId = profile.id;
    const profileRoot = path.join(app.dataRoot, "data", "profiles", profileId);
    const data = path.join(profileRoot, "profile", "Default");
    const preferences = path.join(data, "Preferences");
    const history = path.join(data, "History");
    await mkdir(data, { recursive: true });
    await writeFile(preferences, "remote preferences");
    await writeFile(history, "remote history");
    await app.invoke("set_profile_sync_mode", {
      profileId,
      syncMode: "Regular",
    });
    await app.invoke("request_profile_sync", { profileId });
    await waitFor(
      app,
      async () =>
        (await app.invoke("list_browser_profiles")).some(
          (item) => item.id === profileId && item.last_sync != null,
        ),
      "the source profile finishes its upload",
    );
    const manifestKey = `profiles/${profileId}/manifest.json`;
    const originalManifest = await downloadRemote(manifestKey);
    await app.invoke("save_sync_settings", {
      syncServerUrl: proxyUrl,
      syncToken,
    });
    await app.close();

    await writeFile(preferences, "stale local preferences");
    await writeFile(history, "stale local history");
    const later = new Date(Date.now() + 60_000);
    await Promise.all([
      utimes(preferences, later, later),
      utimes(history, later, later),
    ]);
    await mkdir(path.join(profileRoot, ".donut-sync"), { recursive: true });
    await writeFile(
      path.join(profileRoot, ".donut-sync", "resume-state.json"),
      JSON.stringify({
        profile_id: profileId,
        direction: "download",
        started_at: new Date().toISOString(),
        completed_files: [
          "profile/Default/Preferences",
          "profile/Default/History",
        ],
      }),
    );
    await writeFile(
      path.join(app.dataRoot, "data", "settings", "remote_handoff.json"),
      JSON.stringify({
        [profileId]: {
          session_id: "remote-return-session",
          state: "pending_sync",
          observed_at: Math.floor(Date.now() / 1000),
        },
      }),
    );
    await app.start();
    const pending = async () =>
      (await app.invoke("get_remote_handoff_states"))[profileId] ===
      "pending_sync";
    await waitFor(
      app,
      () => missingManifests >= 2,
      "return waits for the remote manifest",
    );
    assert.equal(await pending(), true);
    assert.deepEqual(await downloadRemote(manifestKey), originalManifest);

    mode = "offline";
    await app.invoke("request_profile_sync", { profileId });
    await waitFor(
      app,
      () => failedPulls >= 6,
      "return keeps trying after five failures",
      120_000,
    );
    assert.equal(await pending(), true);

    mode = "partial";
    await waitFor(
      app,
      () => failedFiles >= 3,
      "a non-critical file fails to return",
    );
    assert.equal(await pending(), true);
    assert.deepEqual(await downloadRemote(manifestKey), originalManifest);

    mode = "healthy";
    await waitFor(
      app,
      async () => !(await pending()),
      "return completes without a restart",
      25_000,
    );
    assert.equal(await readFile(preferences, "utf8"), "remote preferences");
    assert.equal(await readFile(history, "utf8"), "remote history");
    assert.deepEqual(await downloadRemote(manifestKey), originalManifest);
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("two real app devices reconcile profile files and every config entity with last-write-wins", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const deviceA = appFromEnvironment("sync-regular-a");
  const deviceB = appFromEnvironment("sync-regular-b");
  try {
    await Promise.all([deviceA.start(), deviceB.start()]);
    await Promise.all([configureSync(deviceA), configureSync(deviceB)]);

    const group = await deviceA.invoke("create_profile_group", {
      name: "Synced Group A",
    });
    const proxy = await deviceA.invoke("create_stored_proxy", {
      name: "Synced Proxy A",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 8089,
        username: null,
        password: null,
      },
    });
    const vpn = await deviceA.invoke("create_vpn_config_manual", {
      name: "Synced VPN A",
      vpnType: "WireGuard",
      configData: wireGuardFixture(),
    });
    const extension = await deviceA.invoke("add_extension", {
      name: "Synced Extension A",
      fileName: "synced-fixture.zip",
      fileData: [...Buffer.from(extensionZipBase64(), "base64")],
    });
    const extensionGroup = await deviceA.invoke("create_extension_group", {
      name: "Synced Extension Group A",
    });
    await deviceA.invoke("add_extension_to_group", {
      groupId: extensionGroup.id,
      extensionId: extension.id,
    });

    await Promise.all([
      deviceA.invoke("set_group_sync_enabled", {
        groupId: group.id,
        enabled: true,
      }),
      deviceA.invoke("set_proxy_sync_enabled", {
        proxyId: proxy.id,
        enabled: true,
      }),
      deviceA.invoke("set_vpn_sync_enabled", { vpnId: vpn.id, enabled: true }),
      deviceA.invoke("set_extension_sync_enabled", {
        extensionId: extension.id,
        enabled: true,
      }),
      deviceA.invoke("set_extension_group_sync_enabled", {
        extensionGroupId: extensionGroup.id,
        enabled: true,
      }),
    ]);

    const profile = await createProfile(deviceA, "Synced Profile A");
    const profileData = path.join(
      deviceA.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
    );
    await mkdir(profileData, { recursive: true });
    await writeFile(
      path.join(profileData, "Preferences"),
      JSON.stringify({ donutE2E: "regular-profile-payload" }),
    );
    const cookieKey = Buffer.alloc(32, 7);
    await writeFile(path.join(profileData, "..", "os_crypt_key"), cookieKey);
    await deviceA.invoke("update_profile_tags", {
      profileId: profile.id,
      tags: ["sync", "device-a"],
    });
    await deviceA.invoke("update_profile_note", {
      profileId: profile.id,
      note: "regular sync metadata",
    });
    await deviceA.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    await deviceA.invoke("request_profile_sync", { profileId: profile.id });
    assert.equal(
      await deviceA.invoke("cancel_profile_sync", {
        profileId: "not-running-sync",
      }),
      false,
    );

    await waitFor(
      deviceA,
      async () => {
        const keys = (await listRemote("")).map((object) => object.key);
        return [
          `groups/${group.id}.json`,
          `proxies/${proxy.id}.json`,
          `vpns/${vpn.id}.json`,
          `extensions/${extension.id}.json`,
          `extension_groups/${extensionGroup.id}.json`,
          `profiles/${profile.id}/manifest.json`,
          `profiles/${profile.id}/files/profile/Default/Preferences`,
          `profiles/${profile.id}/files/profile/os_crypt_key`,
        ].every((key) => keys.includes(key));
      },
      "all regular entities uploaded",
    );

    await deviceB.invoke("restart_sync_service");
    await waitFor(
      deviceB,
      async () => {
        const [profiles, groups, proxies, vpns, extensions, extensionGroups] =
          await Promise.all([
            deviceB.invoke("list_browser_profiles"),
            deviceB.invoke("get_profile_groups"),
            deviceB.invoke("get_stored_proxies"),
            deviceB.invoke("list_vpn_configs"),
            deviceB.invoke("list_extensions"),
            deviceB.invoke("list_extension_groups"),
          ]);
        return (
          profiles.some((item) => item.id === profile.id) &&
          groups.some((item) => item.id === group.id) &&
          proxies.some((item) => item.id === proxy.id) &&
          vpns.some((item) => item.id === vpn.id) &&
          extensions.some((item) => item.id === extension.id) &&
          extensionGroups.some((item) => item.id === extensionGroup.id)
        );
      },
      "device B receives every entity",
    );
    const downloadedPreferences = path.join(
      deviceB.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
      "Preferences",
    );
    await waitFor(
      deviceB,
      async () =>
        (
          await readFile(downloadedPreferences, "utf8").catch(() => "")
        ).includes("regular-profile-payload"),
      "device B receives profile browser files",
    );
    const profileDirB = path.join(
      deviceB.dataRoot,
      "data",
      "profiles",
      profile.id,
    );
    assert.deepEqual(
      await readFile(path.join(profileDirB, "profile", "os_crypt_key")),
      cookieKey,
    );
    assert.equal(
      (
        await readFile(path.join(profileDirB, ".donut-sync", "origin"), "utf8")
      ).trim(),
      "synced_down",
    );

    // updated_at has one-second resolution. Make the device-B edits
    // unambiguously newer, then verify last-write-wins in both directions.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await deviceB.invoke("update_stored_proxy", {
      proxyId: proxy.id,
      name: "Synced Proxy B Wins",
      proxySettings: null,
    });
    await deviceB.invoke("rename_profile", {
      profileId: profile.id,
      newName: "Synced Profile B Wins",
    });
    await deviceB.invoke("request_profile_sync", { profileId: profile.id });
    await deviceA.invoke("restart_sync_service");
    await waitFor(
      deviceA,
      async () => {
        const proxies = await deviceA.invoke("get_stored_proxies");
        const profiles = await deviceA.invoke("list_browser_profiles");
        return (
          proxies.find((item) => item.id === proxy.id)?.name ===
            "Synced Proxy B Wins" &&
          profiles.find((item) => item.id === profile.id)?.name ===
            "Synced Profile B Wins"
        );
      },
      "newer device-B edits win on device A",
    );

    // Device B publishes a newer copy without the key file. Device A takes the
    // newer files but keeps its key, which every cookie depends on, and puts
    // it back in the cloud.
    const remoteKey = `profiles/${profile.id}/files/profile/os_crypt_key`;
    await rm(path.join(profileDirB, "profile", "os_crypt_key"));
    await writeFile(
      path.join(profileDirB, "profile", "Default", "Preferences"),
      JSON.stringify({ donutE2E: "device-b-without-key" }),
    );
    await deviceB.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      deviceB,
      async () =>
        !(await listRemote("")).some((object) => object.key === remoteKey),
      "device B's copy without the key reaches the cloud",
    );
    await deviceA.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      deviceA,
      async () =>
        (
          await readFile(path.join(profileData, "Preferences"), "utf8").catch(
            () => "",
          )
        ).includes("device-b-without-key") &&
        (await listRemote("")).some((object) => object.key === remoteKey),
      "device A takes the newer files and restores the key in the cloud",
    );
    assert.deepEqual(
      await readFile(path.join(profileData, "..", "os_crypt_key")),
      cookieKey,
    );
    const logDirA = path.join(deviceA.dataRoot, "logs");
    const keptLine = new RegExp(
      `Profile synced profile=${profile.id} .*key_files=os_crypt_key:kept`,
    );
    await waitFor(
      deviceA,
      async () =>
        (
          await Promise.all(
            (
              await readdir(logDirA)
            )
              .filter((name) => name.endsWith(".log"))
              .map((name) => readFile(path.join(logDirA, name), "utf8")),
          )
        ).some((text) => keptLine.test(text)),
      "device A logs that it kept the key file",
    );

    assert.equal(
      await deviceA.invoke("is_proxy_in_use_by_synced_profile", {
        proxyId: proxy.id,
      }),
      false,
    );
    assert.equal(
      await deviceA.invoke("is_group_in_use_by_synced_profile", {
        groupId: group.id,
      }),
      false,
    );
    assert.equal(
      await deviceA.invoke("is_vpn_in_use_by_synced_profile", {
        vpnId: vpn.id,
      }),
      false,
    );
    const counts = await deviceA.invoke("get_unsynced_entity_counts");
    assert.equal(typeof counts.proxies, "number");
    await deviceA.invoke("enable_sync_for_all_entities");

    await Promise.all([
      deviceB.invoke("delete_extension_group", {
        groupId: extensionGroup.id,
      }),
      deviceB.invoke("delete_extension", { extensionId: extension.id }),
      deviceB.invoke("delete_vpn_config", { vpnId: vpn.id }),
      deviceB.invoke("delete_profile_group", { groupId: group.id }),
      deviceB.invoke("delete_stored_proxy", { proxyId: proxy.id }),
      deviceB.invoke("delete_profile", { profileId: profile.id }),
    ]);
    await waitFor(
      deviceB,
      async () => {
        const keys = (await listRemote("")).map((object) => object.key);
        return [
          `tombstones/groups/${group.id}.json`,
          `tombstones/proxies/${proxy.id}.json`,
          `tombstones/vpns/${vpn.id}.json`,
          `tombstones/extensions/${extension.id}.json`,
          `tombstones/extension_groups/${extensionGroup.id}.json`,
          `tombstones/profiles/${profile.id}.json`,
        ].every((key) => keys.includes(key));
      },
      "deletions create every remote tombstone",
    );
    await waitFor(
      deviceA,
      async () => {
        const [profiles, groups, proxies, vpns, extensions, extensionGroups] =
          await Promise.all([
            deviceA.invoke("list_browser_profiles"),
            deviceA.invoke("get_profile_groups"),
            deviceA.invoke("get_stored_proxies"),
            deviceA.invoke("list_vpn_configs"),
            deviceA.invoke("list_extensions"),
            deviceA.invoke("list_extension_groups"),
          ]);
        return (
          !profiles.some((item) => item.id === profile.id) &&
          !groups.some((item) => item.id === group.id) &&
          !proxies.some((item) => item.id === proxy.id) &&
          !vpns.some((item) => item.id === vpn.id) &&
          !extensions.some((item) => item.id === extension.id) &&
          !extensionGroups.some((item) => item.id === extensionGroup.id)
        );
      },
      "remote tombstones delete every entity from device A",
    );
  } catch (error) {
    await Promise.all([deviceA.capture("failure"), deviceB.capture("failure")]);
    throw error;
  } finally {
    await Promise.all([deviceA.close(), deviceB.close()]);
  }
});

test("the first sync of an empty profile publishes a manifest and records completion", async () => {
  const source = appFromEnvironment("sync-empty-source");
  try {
    await source.start();
    await configureSync(source);
    const profile = await createProfile(source, "Empty Profile");
    await source.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    await source.invoke("request_profile_sync", { profileId: profile.id });
    const manifestKey = `profiles/${profile.id}/manifest.json`;
    await waitFor(
      source,
      async () => {
        const profiles = await source.invoke("list_browser_profiles");
        return (
          profiles.find((item) => item.id === profile.id)?.last_sync > 0 &&
          (await listRemote(`profiles/${profile.id}/`)).some(
            (item) => item.key === manifestKey,
          )
        );
      },
      "empty profile has a remote manifest and a completed sync",
    );
    const manifest = JSON.parse(
      (await downloadRemote(manifestKey)).toString("utf8"),
    );
    assert.deepEqual(manifest.files, []);
  } catch (error) {
    await source.capture("failure");
    throw error;
  } finally {
    await source.close();
  }
});

test("a restore point keeps a profile's files and puts them back on every device", async () => {
  const app = appFromEnvironment("sync-restore-points");
  try {
    await app.start();
    await configureSync(app);
    const profile = await createProfile(app, "Restore Point Profile");
    const data = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
    );
    await mkdir(data, { recursive: true });
    const preferences = path.join(data, "Preferences");
    await writeFile(preferences, "kept preferences");
    await app.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    const synced = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      )?.last_sync;
    await app.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      app,
      async () => (await synced()) > 0,
      "the first sync of the profile",
    );

    const point = await app.invoke("create_restore_point", {
      profileId: profile.id,
    });
    assert.equal(point.kind, "manual");
    assert.ok(point.files >= 1, JSON.stringify(point));
    const listed = await app.invoke("list_restore_points", {
      profileId: profile.id,
    });
    assert.ok(
      listed.some((item) => item.id === point.id),
      JSON.stringify(listed),
    );

    // A change after the point, synced up.
    const before = await synced();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await writeFile(preferences, "changed preferences");
    await app.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      app,
      async () => (await synced()) > before,
      "the changed profile synced",
    );

    await app.invoke("restore_restore_point", {
      profileId: profile.id,
      id: point.id,
    });
    assert.equal(await readFile(preferences, "utf8"), "kept preferences");
    const remoteManifest = JSON.parse(
      (await downloadRemote(`profiles/${profile.id}/manifest.json`)).toString(
        "utf8",
      ),
    );
    assert.ok(
      remoteManifest.files.some((file) => file.path.endsWith("Preferences")),
    );
    // The data the restore replaced is a restore point of its own.
    const after = await app.invoke("list_restore_points", {
      profileId: profile.id,
    });
    assert.equal(after.length, listed.length + 1);

    await app.invoke("delete_restore_point", {
      profileId: profile.id,
      id: point.id,
    });
    assert.equal(
      (await app.invoke("list_restore_points", { profileId: profile.id })).some(
        (item) => item.id === point.id,
      ),
      false,
    );
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
  }
});

test("global config sealing and encrypted profile sync reject a wrong password, round-trip with the right one, and roll over", async () => {
  const source = appFromEnvironment("sync-encrypted-source");
  const receiver = appFromEnvironment("sync-encrypted-receiver");
  const rolloverReceiver = appFromEnvironment(
    "sync-encrypted-rollover-receiver",
  );
  try {
    await Promise.all([source.start(), receiver.start()]);
    await Promise.all([configureSync(source), configureSync(receiver)]);
    await source.invoke("set_e2e_password", {
      password: "shared encryption password",
    });
    await receiver.invoke("set_e2e_password", {
      password: "intentionally wrong password",
    });
    assert.equal(await source.invoke("check_has_e2e_password"), true);
    assert.equal(
      await source.invoke("verify_e2e_password", {
        password: "shared encryption password",
      }),
      true,
    );
    assert.equal(
      await source.invoke("verify_e2e_password", { password: "wrong" }),
      false,
    );

    const sealedProxy = await source.invoke("create_stored_proxy", {
      name: "SECRET-CONFIG-MARKER",
      proxySettings: {
        proxy_type: "http",
        host: "secret-proxy.invalid",
        port: 8443,
        username: "secret-user",
        password: "secret-password",
      },
    });
    await source.invoke("set_proxy_sync_enabled", {
      proxyId: sealedProxy.id,
      enabled: true,
    });

    const encryptedProfile = await createProfile(source, "Encrypted Profile");
    const encryptedData = path.join(
      source.dataRoot,
      "data",
      "profiles",
      encryptedProfile.id,
      "profile",
    );
    await mkdir(encryptedData, { recursive: true });
    await writeFile(
      path.join(encryptedData, "Local State"),
      "SECRET-PROFILE-MARKER that must never appear remotely",
    );
    await source.invoke("set_profile_sync_mode", {
      profileId: encryptedProfile.id,
      syncMode: "Encrypted",
    });
    await source.invoke("request_profile_sync", {
      profileId: encryptedProfile.id,
    });

    const proxyKey = `proxies/${sealedProxy.id}.json`;
    const profileMetadataKey = `profiles/${encryptedProfile.id}/metadata.json`;
    const profileFileKey = `profiles/${encryptedProfile.id}/files/profile/Local State`;
    await waitFor(
      source,
      async () => {
        const keys = (await listRemote("")).map((object) => object.key);
        return (
          keys.includes(proxyKey) &&
          keys.includes(profileMetadataKey) &&
          keys.includes(profileFileKey)
        );
      },
      "sealed config and encrypted profile uploaded",
    );
    const sealedBefore = await downloadRemote(proxyKey);
    const metadataBefore = await downloadRemote(profileMetadataKey);
    const encryptedFile = await downloadRemote(profileFileKey);
    assert.equal(
      sealedBefore.includes(Buffer.from("SECRET-CONFIG-MARKER")),
      false,
    );
    assert.equal(sealedBefore.includes(Buffer.from("secret-password")), false);
    assert.equal(
      encryptedFile.includes(Buffer.from("SECRET-PROFILE-MARKER")),
      false,
    );
    const envelope = JSON.parse(sealedBefore.toString("utf8"));
    assert.equal(envelope.v, 1);
    assert.ok(envelope.salt && envelope.ct);

    await receiver.invoke("restart_sync_service");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(
      (await receiver.invoke("get_stored_proxies")).some(
        (item) => item.id === sealedProxy.id,
      ),
      false,
      "wrong password must not materialize sealed config",
    );
    assert.equal(
      (await receiver.invoke("list_browser_profiles")).some(
        (item) => item.id === encryptedProfile.id,
      ),
      false,
      "wrong password must not materialize encrypted profiles",
    );

    await receiver.invoke("set_e2e_password", {
      password: "shared encryption password",
    });
    await receiver.invoke("restart_sync_service");
    await waitFor(
      receiver,
      async () =>
        (await receiver.invoke("get_stored_proxies")).some(
          (item) =>
            item.id === sealedProxy.id && item.name === "SECRET-CONFIG-MARKER",
        ) &&
        (await receiver.invoke("list_browser_profiles")).some(
          (item) => item.id === encryptedProfile.id,
        ),
      "correct password decrypts config and profile metadata",
    );
    const receiverFile = path.join(
      receiver.dataRoot,
      "data",
      "profiles",
      encryptedProfile.id,
      "profile",
      "Local State",
    );
    await waitFor(
      receiver,
      async () =>
        (await readFile(receiverFile, "utf8").catch(() => "")).includes(
          "SECRET-PROFILE-MARKER",
        ),
      "correct password decrypts profile browser file",
    );

    const emptyProfile = await createProfile(source, "Encrypted Empty Profile");
    await source.invoke("set_profile_sync_mode", {
      profileId: emptyProfile.id,
      syncMode: "Encrypted",
    });
    await waitFor(
      source,
      async () =>
        (await listRemote(`profiles/${emptyProfile.id}/`)).some(
          (object) =>
            object.key === `profiles/${emptyProfile.id}/metadata.json`,
        ),
      "empty profile metadata uploaded before rollover",
    );

    await source.invoke("set_e2e_password", {
      password: "rolled encryption password",
    });
    let rollingOver = true;
    let manifestDisappeared = false;
    await Promise.all([
      source.invoke("rollover_encryption_for_all_entities").finally(() => {
        rollingOver = false;
      }),
      (async () => {
        while (rollingOver) {
          const objects = await listRemote(`profiles/${encryptedProfile.id}/`);
          manifestDisappeared ||= !objects.some(
            (object) =>
              object.key === `profiles/${encryptedProfile.id}/manifest.json`,
          );
          if (rollingOver) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
      })(),
    ]);
    assert.equal(
      manifestDisappeared,
      false,
      "rollover must not let another device interpret a missing manifest as an empty remote profile",
    );
    assert.ok(
      (await listRemote(`profiles/${emptyProfile.id}/`)).some(
        (object) => object.key === `profiles/${emptyProfile.id}/manifest.json`,
      ),
      "rollover must publish a manifest even for an empty profile",
    );
    await waitFor(
      source,
      async () => {
        const [proxy, metadata] = await Promise.all([
          downloadRemote(proxyKey),
          downloadRemote(profileMetadataKey),
        ]);
        return !proxy.equals(sealedBefore) && !metadata.equals(metadataBefore);
      },
      "password rollover rewrites sealed config and profile metadata",
    );
    const sealedAfter = await downloadRemote(proxyKey);
    assert.equal(
      sealedAfter.includes(Buffer.from("SECRET-CONFIG-MARKER")),
      false,
    );
    await receiver.invoke("set_e2e_password", {
      password: "rolled encryption password",
    });
    await receiver.invoke("restart_sync_service");
    await waitFor(
      receiver,
      async () =>
        (await receiver.invoke("get_stored_proxies")).some(
          (item) =>
            item.id === sealedProxy.id && item.name === "SECRET-CONFIG-MARKER",
        ),
      "receiver accepts rolled password",
    );

    await rolloverReceiver.start();
    await rolloverReceiver.invoke("set_e2e_password", {
      password: "rolled encryption password",
    });
    await configureSync(rolloverReceiver);
    await waitFor(
      rolloverReceiver,
      async () =>
        (await rolloverReceiver.invoke("get_stored_proxies")).some(
          (item) =>
            item.id === sealedProxy.id && item.name === "SECRET-CONFIG-MARKER",
        ) &&
        (await rolloverReceiver.invoke("list_browser_profiles")).some(
          (item) => item.id === encryptedProfile.id,
        ),
      "fresh receiver decrypts rolled config and profile metadata",
    );
    const rolloverFile = path.join(
      rolloverReceiver.dataRoot,
      "data",
      "profiles",
      encryptedProfile.id,
      "profile",
      "Local State",
    );
    await waitFor(
      rolloverReceiver,
      async () =>
        (await readFile(rolloverFile, "utf8").catch(() => "")).includes(
          "SECRET-PROFILE-MARKER",
        ),
      "fresh receiver decrypts rolled profile browser file",
    );

    await source.invoke("set_profile_sync_mode", {
      profileId: encryptedProfile.id,
      syncMode: "Disabled",
    });
    await source.invoke("set_profile_sync_mode", {
      profileId: emptyProfile.id,
      syncMode: "Disabled",
    });
    await source.invoke("delete_e2e_password");
    assert.equal(await source.invoke("check_has_e2e_password"), false);
    const missingPassword = await source.invokeError("verify_e2e_password", {
      password: "rolled encryption password",
    });
    assert.match(missingPassword, /NO_E2E_PASSWORD_SET/);
  } catch (error) {
    await Promise.all([
      source.capture("failure"),
      receiver.capture("failure"),
      rolloverReceiver.capture("failure"),
    ]);
    throw error;
  } finally {
    await Promise.all([
      source.close(),
      receiver.close(),
      rolloverReceiver.close(),
    ]);
  }
});

test("a synced profile restored from the trash keeps its sync, and a delete made offline is not undone by the next sync", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const app = appFromEnvironment("sync-trash");
  try {
    await app.start();
    await configureSync(app);

    const remoteHas = async (key) =>
      (await listRemote(key)).some((object) => object.key === key);
    const manifestKey = (id) => `profiles/${id}/manifest.json`;
    const tombstoneKey = (id) => `tombstones/profiles/${id}.json`;
    const isLive = async (id) =>
      (await app.invoke("list_browser_profiles")).some(
        (profile) => profile.id === id,
      );
    const pendingFile = path.join(
      app.dataRoot,
      "data",
      "pending_profile_deletes.json",
    );
    // The pipeline logs this once its reconcile at sync start has finished.
    const logDir = path.join(app.dataRoot, "logs");
    const pipelineStarts = async () => {
      let count = 0;
      for (const name of await readdir(logDir)) {
        if (!name.endsWith(".log")) continue;
        const text = await readFile(path.join(logDir, name), "utf8");
        count += text.split("Sync scheduler started").length - 1;
      }
      return count;
    };
    const restartSync = async (description) => {
      const before = await pipelineStarts();
      await app.invoke("restart_sync_service");
      await waitFor(
        app,
        async () => (await pipelineStarts()) > before,
        description,
      );
    };
    const syncedProfile = async (name) => {
      const profile = await createProfile(app, name);
      const data = path.join(
        app.dataRoot,
        "data",
        "profiles",
        profile.id,
        "profile",
        "Default",
      );
      await mkdir(data, { recursive: true });
      await writeFile(path.join(data, "Preferences"), JSON.stringify({ name }));
      await app.invoke("set_profile_sync_mode", {
        profileId: profile.id,
        syncMode: "Regular",
      });
      await app.invoke("request_profile_sync", { profileId: profile.id });
      await waitFor(
        app,
        () => remoteHas(manifestKey(profile.id)),
        `${name} uploaded`,
      );
      return profile;
    };

    // Restored at once, while the cloud delete may still be running. The
    // restore waits for that delete and clears its tombstone before sync is
    // back on, so nothing can erase the restored profile afterwards.
    const kept = await syncedProfile("Trash Round Trip");
    await app.invoke("delete_profile", { profileId: kept.id });
    const [entry] = await app.invoke("list_trashed_profiles");
    assert.equal(entry.id, kept.id);
    assert.equal(entry.sync_enabled, true);
    const restored = await app.invoke("restore_trashed_profile", {
      profileId: kept.id,
    });
    assert.equal(restored.sync_mode, "Regular");
    assert.equal(
      await remoteHas(tombstoneKey(kept.id)),
      false,
      "the restore clears the tombstone of the delete",
    );
    await waitFor(
      app,
      () => remoteHas(manifestKey(kept.id)),
      "the restored profile uploads again",
    );
    await restartSync("the reconcile after the restore finishes");
    assert.equal(
      await isLive(kept.id),
      true,
      "the reconcile at sync start keeps the restored profile",
    );

    // Deleted while the server cannot be reached: the delete is owed, and the
    // next sync start carries it out instead of downloading the profile back.
    const offline = await syncedProfile("Deleted Offline");
    await app.invoke("save_sync_settings", {
      syncServerUrl: "http://127.0.0.1:9",
      syncToken,
    });
    await app.invoke("delete_profile", { profileId: offline.id });
    await waitFor(
      app,
      async () =>
        JSON.parse(await readFile(pendingFile, "utf8")).some(
          (pending) => pending.profile_id === offline.id,
        ),
      "the unreachable delete is recorded",
    );
    assert.equal(await remoteHas(manifestKey(offline.id)), true);

    await app.invoke("save_sync_settings", {
      syncServerUrl: syncUrl,
      syncToken,
    });
    await restartSync("the reconcile with the owed delete finishes");
    assert.equal(await remoteHas(tombstoneKey(offline.id)), true);
    assert.equal(await remoteHas(manifestKey(offline.id)), false);
    assert.equal(
      await isLive(offline.id),
      false,
      "the profile deleted offline does not come back",
    );
    assert.deepEqual(
      (await app.invoke("list_trashed_profiles")).map((item) => item.id),
      [offline.id],
    );
    await assert.rejects(readFile(pendingFile, "utf8"), { code: "ENOENT" });
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
  }
});

test("a synced group and proxy sent to the trash leave the cloud, and a restore brings them back synced", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const app = appFromEnvironment("sync-entity-trash");
  try {
    await app.start();
    await configureSync(app);

    const remoteHas = async (key) =>
      (await listRemote(key)).some((object) => object.key === key);
    const group = await app.invoke("create_profile_group", {
      name: "Trashed Synced Group",
    });
    const proxy = await app.invoke("create_stored_proxy", {
      name: "Trashed Synced Proxy",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 8090,
        username: null,
        password: null,
      },
    });
    await app.invoke("set_group_sync_enabled", {
      groupId: group.id,
      enabled: true,
    });
    await app.invoke("set_proxy_sync_enabled", {
      proxyId: proxy.id,
      enabled: true,
    });
    const entities = [
      { kind: "group", id: group.id, folder: "groups" },
      { kind: "proxy", id: proxy.id, folder: "proxies" },
    ];
    for (const { id, folder } of entities) {
      await waitFor(
        app,
        () => remoteHas(`${folder}/${id}.json`),
        `${folder} entity uploaded`,
      );
    }

    // From the cloud's side a trashed entity is deleted, as a permanent
    // delete leaves it: no object, and a tombstone for the other devices.
    for (const { kind, id } of entities) {
      assert.deepEqual(await app.invoke("trash_entity", { kind, id }), {
        trashed: true,
      });
    }
    for (const { id, folder } of entities) {
      await waitFor(
        app,
        async () =>
          (await remoteHas(`tombstones/${folder}/${id}.json`)) &&
          !(await remoteHas(`${folder}/${id}.json`)),
        `${folder} entity deleted in the cloud`,
      );
    }
    const trashed = await app.invoke("list_trashed_entities");
    for (const { kind, id } of entities) {
      assert.equal(
        trashed.find((entry) => entry.kind === kind && entry.id === id)
          ?.sync_enabled,
        true,
      );
    }

    // The restore clears the tombstone before it turns sync back on, so the
    // entity uploads again and no device erases it.
    for (const { kind, id, folder } of entities) {
      const restored = await app.invoke("restore_trashed_entity", { kind, id });
      assert.equal(restored.sync_stayed_off, false);
      assert.equal(
        await remoteHas(`tombstones/${folder}/${id}.json`),
        false,
        `the ${kind} restore clears its tombstone`,
      );
    }
    for (const { id, folder } of entities) {
      await waitFor(
        app,
        () => remoteHas(`${folder}/${id}.json`),
        `${folder} entity uploaded again`,
      );
    }
    assert.equal(
      (await app.invoke("get_profile_groups")).find(
        (item) => item.id === group.id,
      )?.sync_enabled,
      true,
    );
    assert.equal(
      (await app.invoke("get_stored_proxies")).find(
        (item) => item.id === proxy.id,
      )?.sync_enabled,
      true,
    );
    assert.deepEqual(await app.invoke("list_trashed_entities"), []);
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await app.close();
  }
});

// A self-hosted server reaches its storage over an address only it can
// resolve — the documented compose file points S3_ENDPOINT at
// http://minio:9000, a Docker service name that exists on the compose network
// and nowhere else. Files never travel through the sync server, so every
// presigned URL then names a host the desktop cannot open: /health and /readyz
// stay green while every single transfer dies at connect. Reported as "the
// endpoint connection works every time, but no MB is ever synced".
async function leaseRequest(route, body) {
  const response = await fetch(`${syncUrl}/v1/locks/${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${syncToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function backendCode(error) {
  const text = String(error?.message ?? error);
  const start = text.indexOf('{"code"');
  if (start < 0) return { code: null, text };
  const end = text.lastIndexOf("}");
  return { ...JSON.parse(text.slice(start, end + 1)), text };
}

test("one device at a time runs a synced profile: a second launch is refused, take over moves it, expiry frees it", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const deviceA = appFromEnvironment("sync-lease-a");
  const deviceB = appFromEnvironment("sync-lease-b");
  try {
    await Promise.all([deviceA.start(), deviceB.start()]);
    await Promise.all([configureSync(deviceA), configureSync(deviceB)]);
    // Every launch below stops at the route check, past the lease, so no
    // browser is needed: PROFILE_ROUTE_REQUIRED means the lease was granted.
    for (const app of [deviceA, deviceB]) {
      const settings = await app.invoke("get_app_settings");
      await app.invoke("save_app_settings", {
        settings: { ...settings, require_route_for_launch: true },
      });
    }

    const profile = await createProfile(deviceB, "Leased Profile");
    const profileData = path.join(
      deviceB.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
    );
    await mkdir(profileData, { recursive: true });
    await writeFile(path.join(profileData, "Preferences"), "{}");
    await deviceB.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    await deviceB.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      deviceB,
      async () =>
        (await listRemote(`profiles/${profile.id}/`)).some(
          (object) => object.key === `profiles/${profile.id}/manifest.json`,
        ),
      "profile uploaded",
    );
    await deviceA.invoke("restart_sync_service");
    await waitFor(
      deviceA,
      async () =>
        (await deviceA.invoke("list_browser_profiles")).some(
          (item) => item.id === profile.id,
        ),
      "device A receives the profile",
    );
    const onA = (await deviceA.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    const onB = (await deviceB.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    const profileRoot = `profiles/${profile.id}/`;
    const launch = (app, item) =>
      app.invokeError("launch_browser_profile", { profile: item, url: null });

    // A third device of the same account holds the lease.
    const other = await leaseRequest("acquire", {
      profileRoot,
      deviceId: "e2e-other-device",
      deviceName: "Other Laptop",
      ttlSeconds: 90,
    });
    assert.equal(other.status, 200, JSON.stringify(other.body));

    const refused = backendCode(await launch(deviceB, onB));
    assert.equal(refused.code, "PROFILE_LEASE_HELD", refused.text);
    assert.equal(refused.params.device, "Other Laptop");
    assert.equal(refused.params.canTakeOver, "true");
    assert.ok(Date.parse(refused.params.expiresAt) > Date.now());

    // Take over: device B holds it, the other device's renew is refused.
    await deviceB.invoke("take_over_profile_lease", { profileId: profile.id });
    const held = await leaseRequest("status", { profileRoot });
    assert.equal(held.body.held, true);
    assert.notEqual(held.body.holder.deviceId, "e2e-other-device");
    const renew = await leaseRequest("renew", {
      profileRoot,
      token: other.body.token,
    });
    assert.equal(renew.status, 409);
    assert.equal(renew.body.code, "PROFILE_LEASE_LOST");

    // The second real device is refused while device B holds it.
    const second = backendCode(await launch(deviceA, onA));
    assert.equal(second.code, "PROFILE_LEASE_HELD", second.text);
    assert.equal(second.params.device, held.body.holder.deviceName);

    // Device A takes it over and launches: the lease step passes.
    await deviceA.invoke("take_over_profile_lease", { profileId: profile.id });
    const launchedA = backendCode(await launch(deviceA, onA));
    assert.equal(launchedA.code, "PROFILE_ROUTE_REQUIRED", launchedA.text);
    // Its browser never ran: once the sync after the stop is done, the lease
    // is released.
    await waitFor(
      deviceA,
      async () =>
        (await leaseRequest("status", { profileRoot })).body.held === false,
      "lease released after the launch ended",
      90_000,
    );

    // A lease that is not renewed expires and frees the profile.
    const stale = await leaseRequest("acquire", {
      profileRoot,
      deviceId: "e2e-other-device",
      deviceName: "Other Laptop",
      ttlSeconds: 90,
    });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(
      backendCode(await launch(deviceB, onB)).code,
      "PROFILE_LEASE_HELD",
    );
    const waitMs = Date.parse(stale.body.expiresAt) - Date.now() + 1_000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    const afterExpiry = backendCode(await launch(deviceB, onB));
    assert.equal(afterExpiry.code, "PROFILE_ROUTE_REQUIRED", afterExpiry.text);
  } catch (error) {
    await Promise.all([deviceA.capture("failure"), deviceB.capture("failure")]);
    throw error;
  } finally {
    await Promise.all([deviceA.close(), deviceB.close()]);
  }
});

function writeCookie(file, value) {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE IF NOT EXISTS cookies (host_key TEXT, name TEXT, value TEXT, PRIMARY KEY (host_key, name))",
  );
  db.prepare(
    "INSERT OR REPLACE INTO cookies VALUES ('.google.com', 'SID', ?)",
  ).run(value);
  db.close();
}

function readCookie(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM cookies WHERE name = 'SID'")
      .get();
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

test("a launch takes the newest cookie jar another device uploaded before the browser starts", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const deviceA = appFromEnvironment("sync-pull-a");
  const deviceB = appFromEnvironment("sync-pull-b");
  try {
    await Promise.all([deviceA.start(), deviceB.start()]);
    await Promise.all([configureSync(deviceA), configureSync(deviceB)]);
    const settings = await deviceB.invoke("get_app_settings");
    await deviceB.invoke("save_app_settings", {
      settings: { ...settings, require_route_for_launch: true },
    });

    const profile = await createProfile(deviceA, "Pulled Profile");
    const jar = (app) =>
      path.join(
        app.dataRoot,
        "data",
        "profiles",
        profile.id,
        "profile",
        "Default",
        "Network",
        "Cookies",
      );
    await mkdir(path.dirname(jar(deviceA)), { recursive: true });
    writeCookie(jar(deviceA), "session-1");
    await deviceA.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    await deviceA.invoke("request_profile_sync", { profileId: profile.id });
    const cookieKey = `profiles/${profile.id}/files/profile/Default/Network/Cookies`;
    await waitFor(
      deviceA,
      async () =>
        (await listRemote(`profiles/${profile.id}/`)).some(
          (object) => object.key === cookieKey,
        ),
      "device A uploaded the first cookie jar",
    );
    await deviceB.invoke("restart_sync_service");
    await waitFor(
      deviceB,
      async () => readCookie(jar(deviceB)) === "session-1",
      "device B has the first cookie jar",
      90_000,
    );

    // Device A ran the profile: the site rotated its session cookie, and A
    // uploaded the jar when the browser stopped.
    const manifestKey = `profiles/${profile.id}/manifest.json`;
    const before = (await listRemote(`profiles/${profile.id}/`)).find(
      (object) => object.key === manifestKey,
    )?.lastModified;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    writeCookie(jar(deviceA), "session-2");
    await deviceA.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      deviceA,
      async () =>
        (await listRemote(`profiles/${profile.id}/`)).find(
          (object) => object.key === manifestKey,
        )?.lastModified !== before,
      "device A uploaded the rotated jar",
    );

    // Device B launches right away: the launch itself brings the jar down.
    const onB = (await deviceB.invoke("list_browser_profiles")).find(
      (item) => item.id === profile.id,
    );
    const launched = backendCode(
      await deviceB.invokeError("launch_browser_profile", {
        profile: onB,
        url: null,
      }),
    );
    assert.equal(launched.code, "PROFILE_ROUTE_REQUIRED", launched.text);
    assert.equal(readCookie(jar(deviceB)), "session-2");
  } catch (error) {
    await Promise.all([deviceA.capture("failure"), deviceB.capture("failure")]);
    throw error;
  } finally {
    await Promise.all([deviceA.close(), deviceB.close()]);
  }
});

test("a proxy set while the profile syncs stays set, and the launch that waits for that sync uses it", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const app = appFromEnvironment("sync-edit-during-sync");
  let holdKey = null;
  const held = Promise.withResolvers();
  const release = Promise.withResolvers();
  const leaseAsked = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (request.url.endsWith("/subscribe")) {
        response.writeHead(503).end();
        return;
      }
      const input = body ? JSON.parse(body) : {};
      if (holdKey && input.key === holdKey) {
        holdKey = null;
        held.resolve();
        await release.promise;
      }
      if (request.url === "/v1/locks/acquire") leaseAsked.resolve();
      const upstream = await fetch(`${syncUrl}${request.url}`, {
        method: request.method,
        headers: {
          authorization: `Bearer ${syncToken}`,
          "content-type": "application/json",
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      response.writeHead(upstream.status, {
        "content-type": "application/json",
      });
      response.end(text);
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await app.start();
    await app.invoke("save_sync_settings", {
      syncServerUrl: serverUrl,
      syncToken,
    });
    await app.invoke("restart_sync_service");
    const settings = await app.invoke("get_app_settings");
    await app.invoke("save_app_settings", {
      settings: { ...settings, require_route_for_launch: true },
    });

    const profile = await createProfile(app, "Edited While Syncing");
    const data = path.join(
      app.dataRoot,
      "data",
      "profiles",
      profile.id,
      "profile",
      "Default",
    );
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "Preferences"), "{}");
    await app.invoke("set_profile_sync_mode", {
      profileId: profile.id,
      syncMode: "Regular",
    });
    await app.invoke("request_profile_sync", { profileId: profile.id });
    await waitFor(
      app,
      async () =>
        (await app.invoke("list_browser_profiles")).some(
          (item) => item.id === profile.id && item.last_sync != null,
        ),
      "the first upload finishes",
    );
    const proxy = await app.invoke("create_stored_proxy", {
      name: "Set While Syncing",
      proxySettings: {
        proxy_type: "http",
        host: "127.0.0.1",
        port: 9,
        username: null,
        password: null,
      },
    });

    // The sync a stopped browser starts: it read the profile, then waits on
    // the server while the proxy is set.
    holdKey = `profiles/${profile.id}/manifest.json`;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await writeFile(path.join(data, "Preferences"), '{"session":2}');
    await app.invoke("request_profile_sync", { profileId: profile.id });
    await held.promise;
    await app.invoke("update_profile_proxy", {
      profileId: profile.id,
      proxyId: proxy.id,
    });
    const stored = async () =>
      (await app.invoke("list_browser_profiles")).find(
        (item) => item.id === profile.id,
      );
    assert.equal((await stored()).proxy_id, proxy.id);

    // The launch takes the lease, then its pull waits for that sync.
    const launch = app.invokeError("launch_browser_profile", {
      profile: await stored(),
      url: null,
    });
    await leaseAsked.promise;
    release.resolve();
    const launched = backendCode(await launch);
    assert.notEqual(launched.code, "PROFILE_ROUTE_REQUIRED", launched.text);
    assert.equal(
      (await stored()).proxy_id,
      proxy.id,
      "the proxy set during the sync stays",
    );
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    release.resolve();
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the connection check fails a server whose storage host this device cannot reach", async () => {
  assert.ok(syncUrl && syncToken, "Sync infrastructure was not started");
  const app = appFromEnvironment("sync-preflight");

  // Answers exactly like a healthy self-hosted server that signs presigned
  // URLs against a container-only host.
  const misconfigured = createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ready",
          s3: true,
          storageEndpoint: "http://minio.invalid:9000",
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => misconfigured.listen(0, "127.0.0.1", resolve));
  const misconfiguredUrl = `http://127.0.0.1:${misconfigured.address().port}`;

  try {
    await app.start();

    const healthy = await app.invoke("check_sync_server_connection", {
      serverUrl: syncUrl,
    });
    assert.equal(healthy.server_reachable, true, "real sync server answers");
    assert.notEqual(
      healthy.storage_reachable,
      false,
      "the suite's own storage must be reachable from the test device",
    );

    // The regression itself: green server, storage nobody here can open.
    const broken = await app.invoke("check_sync_server_connection", {
      serverUrl: misconfiguredUrl,
    });
    assert.equal(broken.server_reachable, true, "server itself answered");
    assert.equal(broken.storage_ready, true, "server reaches its own storage");
    assert.equal(broken.storage_endpoint, "http://minio.invalid:9000");
    assert.equal(
      broken.storage_reachable,
      false,
      "an unreachable storage host must not report as a working connection",
    );
    assert.ok(
      broken.storage_error && broken.storage_error.length > 0,
      "the failure must carry a cause",
    );
    assert.notEqual(
      broken.storage_error,
      "error sending request",
      "the cause must name the transport failure, not the bare reqwest text",
    );

    // A server that does not answer at all stays a plain connection failure,
    // so the two are never confused in the UI.
    const dead = await app.invoke("check_sync_server_connection", {
      serverUrl: "http://127.0.0.1:1",
    });
    assert.equal(dead.server_reachable, false);
    assert.equal(dead.storage_reachable, null);
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await new Promise((resolve) => misconfigured.close(resolve));
    await app.close();
  }
});

// A paid account syncs with its own server only while signed in, with a token
// the Donut API binds to that server's address, and a signed-in device picks
// between Donut cloud and its stored servers. The suites cannot sign in, so
// this covers what a device sees on its own: the address the server names on
// /readyz, the refusals that keep a signed-out device from storing a server or
// a pick, and the shared-token server as the signed-out source.
test("an own sync server is read from /readyz and needs a signed-in account", async () => {
  const app = appFromEnvironment("sync-account-server");
  const accountServer = createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ready",
          s3: true,
          accountUrl: "https://sync.example.test",
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => accountServer.listen(0, "127.0.0.1", resolve));
  const accountServerUrl = `http://127.0.0.1:${accountServer.address().port}`;

  try {
    await app.start();

    const check = await app.invoke("check_sync_server_connection", {
      serverUrl: accountServerUrl,
    });
    assert.equal(check.server_reachable, true);
    assert.equal(check.account_url, "https://sync.example.test");

    const nothing = {
      active: null,
      account_server: null,
      self_hosted_server: null,
    };
    assert.deepEqual(await app.invoke("get_sync_source"), nothing);
    const refused = await app.invokeError("set_account_sync_server", {
      serverUrl: accountServerUrl,
    });
    assert.match(refused, /"code":"ACCOUNT_SYNC_SIGN_IN_REQUIRED"/);
    // Forgetting the own server is always allowed, and stores nothing.
    assert.deepEqual(
      await app.invoke("set_account_sync_server", { serverUrl: null }),
      nothing,
    );
    for (const source of ["cloud", "account", "self_hosted"]) {
      assert.match(
        await app.invokeError("set_sync_source", { source }),
        /"code":"ACCOUNT_SYNC_SIGN_IN_REQUIRED"/,
      );
    }

    // A settings save from the frontend never writes the server or the pick.
    const settings = await app.invoke("get_app_settings");
    await app.invoke("save_app_settings", {
      settings: {
        ...settings,
        account_sync_server_url: accountServerUrl,
        sync_source: "account",
      },
    });
    assert.deepEqual(await app.invoke("get_sync_source"), nothing);
    assert.equal((await app.invoke("get_app_settings")).sync_source, null);

    // Signed out, the shared-token server is the source.
    const saved = await app.invoke("save_sync_settings", {
      syncServerUrl: accountServerUrl,
      syncToken: "e2e-shared-token",
    });
    assert.equal(saved.source, "self_hosted");
    assert.deepEqual(await app.invoke("get_sync_source"), {
      active: "self_hosted",
      account_server: null,
      self_hosted_server: accountServerUrl,
    });
    await app.invoke("save_sync_settings", {
      syncServerUrl: null,
      syncToken: null,
    });
    assert.deepEqual(await app.invoke("get_sync_source"), nothing);
  } catch (error) {
    await app.capture("failure");
    throw error;
  } finally {
    await new Promise((resolve) => accountServer.close(resolve));
    await app.close();
  }
});
