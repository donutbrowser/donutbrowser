import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appImageArch,
  freshAppImages,
  isSystemLibrary,
} from "./appimage-system-libs.mjs";

test("every Wayland library comes from the system, nothing else does", () => {
  for (const name of [
    "libwayland-client.so.0",
    "libwayland-cursor.so.0",
    "libwayland-egl.so.1",
    "libwayland-server.so.0",
    "libwayland-client.so.0.20.0",
  ]) {
    assert.ok(isSystemLibrary(name), name);
  }
  for (const name of [
    "libgtk-3.so.0",
    "libwebkit2gtk-4.1.so.0",
    "libepoxy.so.0",
    "im-wayland.so",
    "libwayland-client.so.0.debug",
  ]) {
    assert.ok(!isSystemLibrary(name), name);
  }
});

test("linuxdeploy's architecture follows Tauri's AppImage name", () => {
  assert.equal(appImageArch("/b/Donut_0.35.5_amd64.AppImage"), "x86_64");
  assert.equal(appImageArch("/b/Donut_0.35.5_aarch64.AppImage"), "aarch64");
  assert.throws(() => appImageArch("/b/Donut.AppImage"));
});

test("only the AppImages this build wrote are repacked", () => {
  const target = mkdtempSync(join(tmpdir(), "appimage-target-"));
  try {
    const host = join(target, "release", "bundle", "appimage");
    const cross = join(
      target,
      "x86_64-unknown-linux-gnu",
      "release",
      "bundle",
      "appimage",
    );
    mkdirSync(host, { recursive: true });
    mkdirSync(cross, { recursive: true });
    writeFileSync(join(target, "CACHEDIR.TAG"), "");
    const fresh = join(cross, "Donut_1.0.0_amd64.AppImage");
    const old = join(host, "Donut_0.9.0_amd64.AppImage");
    writeFileSync(fresh, "");
    writeFileSync(old, "");
    writeFileSync(join(cross, "Donut_1.0.0_amd64.AppImage.zsync"), "");
    const since = Date.now() - 1000;
    utimesSync(old, new Date(since - 60_000), new Date(since - 60_000));

    assert.deepEqual(freshAppImages(target, since), [fresh]);
    assert.deepEqual(freshAppImages(join(target, "missing"), since), []);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
