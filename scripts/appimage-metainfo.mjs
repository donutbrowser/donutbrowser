// The AppStream metainfo the AppImage carries, made from the shared one
// before Tauri bundles (`beforeBundleCommand`). AppImage tools look for
// `usr/share/metainfo/*.appdata.xml`, and the AppImage's desktop entry is
// `Donut.desktop`, not the Flatpak's `com.donutbrowser.DonutBrowser.desktop`.
// The URL types AppStream 0.15 does not know (Ubuntu 22.04, the oldest
// system the AppImage runs on) are left out, so the file validates there.
// The version being bundled becomes the newest release, as
// packaging/linux/stamp-release.sh does for the Flatpak and the Snap.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED_METAINFO = resolve(
  ROOT,
  "packaging/linux/com.donutbrowser.DonutBrowser.metainfo.xml",
);
/** Where `bundle.linux.appimage.files` in tauri.conf.json takes it from. */
export const APPIMAGE_METAINFO = resolve(
  ROOT,
  "src-tauri/target/appimage/com.donutbrowser.DonutBrowser.appdata.xml",
);

const SHARED_LAUNCHABLE =
  '<launchable type="desktop-id">com.donutbrowser.DonutBrowser.desktop</launchable>';
const APPIMAGE_LAUNCHABLE =
  '<launchable type="desktop-id">Donut.desktop</launchable>';
const NEWER_URL_TYPES =
  /^[ \t]*<url type="(?:vcs-browser|contribute)">.*<\/url>\r?\n/gm;
const RELEASES = /^([ \t]*)<releases>\r?\n/m;

export function appimageMetainfo(shared, version, date) {
  if (!shared.includes(SHARED_LAUNCHABLE)) {
    throw new Error(`The shared metainfo has no ${SHARED_LAUNCHABLE}`);
  }
  if (!RELEASES.test(shared)) {
    throw new Error("The shared metainfo has no <releases>");
  }
  const withoutNewerUrls = shared
    .replace(SHARED_LAUNCHABLE, APPIMAGE_LAUNCHABLE)
    .replace(NEWER_URL_TYPES, "");
  if (withoutNewerUrls.includes(`<release version="${version}"`)) {
    return withoutNewerUrls;
  }
  return withoutNewerUrls.replace(
    RELEASES,
    (line, indent) =>
      `${line}${indent}  <release version="${version}" date="${date}" />\n`,
  );
}

function main() {
  const { version } = JSON.parse(
    readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"),
  );
  mkdirSync(dirname(APPIMAGE_METAINFO), { recursive: true });
  writeFileSync(
    APPIMAGE_METAINFO,
    appimageMetainfo(
      readFileSync(SHARED_METAINFO, "utf8"),
      version,
      new Date().toISOString().slice(0, 10),
    ),
  );
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) main();
