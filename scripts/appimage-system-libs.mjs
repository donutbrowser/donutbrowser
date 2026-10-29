// Takes the Wayland libraries out of the AppImages `tauri build` made. They
// belong to the graphics stack of the system the AppImage runs on: its EGL
// (Mesa or the NVIDIA driver) loads them, and copies from the build machine
// (Ubuntu 22.04, Wayland 1.20) lack symbols that newer EGL needs, such as
// `wl_display_create_queue_with_name` in Mesa 25. EGL then fails to load and
// the window stays white on Wayland. Every desktop that runs the AppImage has
// these libraries, because GTK and Mesa depend on them.
//
// linuxdeploy copies them because nothing tells it not to, and Tauri passes it
// no exclusions, so the AppImage is unpacked, the libraries are deleted, and
// it is packed again with the same appimage plugin, update information and
// .zsync file that Tauri's run used.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src-tauri", "target");

/** Library file names the AppImage must take from the system. */
export function isSystemLibrary(name) {
  return /^libwayland-[a-z]+\.so(\.\d+)*$/.test(name);
}

/** The AppImages under `target` written at or after `since` (ms). */
export function freshAppImages(target, since) {
  const bundleDirs = [];
  for (const profile of ["release", "debug"]) {
    bundleDirs.push(join(target, profile, "bundle", "appimage"));
  }
  if (existsSync(target)) {
    for (const triple of readdirSync(target)) {
      for (const profile of ["release", "debug"]) {
        bundleDirs.push(join(target, triple, profile, "bundle", "appimage"));
      }
    }
  }
  return bundleDirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".AppImage"))
        .map((name) => join(dir, name)),
    )
    .filter((file) => statSync(file).mtimeMs >= since);
}

/** linuxdeploy's `ARCH` for an AppImage named the way Tauri names it. */
export function appImageArch(file) {
  const match = /_(amd64|x86_64|aarch64|arm64)\.AppImage$/.exec(basename(file));
  if (!match) throw new Error(`No architecture in ${basename(file)}`);
  return { amd64: "x86_64", arm64: "aarch64" }[match[1]] ?? match[1];
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function appImagePlugin() {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const plugin = join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage");
  if (!existsSync(plugin)) {
    throw new Error(`Tauri's appimage plugin is missing: ${plugin}`);
  }
  return plugin;
}

/** The library files under `appDir/usr/lib` that the system must provide. */
function systemLibraries(appDir) {
  const lib = join(appDir, "usr", "lib");
  return existsSync(lib)
    ? readdirSync(lib)
        .filter(isSystemLibrary)
        .map((name) => join(lib, name))
    : [];
}

function extract(appImage, into, pattern) {
  run(appImage, ["--appimage-extract", ...(pattern ? [pattern] : [])], {
    cwd: into,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  return join(into, "squashfs-root");
}

export function repack(appImage) {
  const work = mkdtempSync(join(tmpdir(), "donut-appimage-"));
  try {
    const appDir = extract(appImage, work);
    const removed = systemLibraries(appDir);
    if (removed.length === 0) {
      console.log(`${basename(appImage)}: no Wayland libraries bundled`);
      return;
    }
    for (const file of removed) rmSync(file);

    // appimagetool writes the .zsync file into the folder it runs in, so the
    // new one replaces the one Tauri's run left.
    const name = `${basename(appImage)}.zsync`;
    const zsyncDir =
      [join(ROOT, "src-tauri"), dirname(appImage)].find((dir) =>
        existsSync(join(dir, name)),
      ) ?? dirname(appImage);
    rmSync(appImage);
    run(appImagePlugin(), ["--appimage-extract-and-run", "--appdir", appDir], {
      cwd: zsyncDir,
      env: { ...process.env, OUTPUT: appImage, ARCH: appImageArch(appImage) },
    });

    const check = mkdtempSync(join(tmpdir(), "donut-appimage-check-"));
    try {
      const left = systemLibraries(
        extract(appImage, check, "usr/lib/libwayland-*"),
      );
      if (left.length > 0) {
        throw new Error(`${basename(appImage)} still bundles ${left}`);
      }
    } finally {
      rmSync(check, { recursive: true, force: true });
    }
    console.log(
      `${basename(appImage)}: removed ${removed.map((file) => basename(file)).join(" ")}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Repack every AppImage the build that started at `since` wrote. */
export function repackFreshAppImages(since) {
  for (const appImage of freshAppImages(TARGET, since)) repack(appImage);
}
