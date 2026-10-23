import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appimageMetainfo, SHARED_METAINFO } from "./appimage-metainfo.mjs";

const shared = readFileSync(SHARED_METAINFO, "utf8");

test("the AppImage's metainfo is launched by the AppImage's desktop entry", () => {
  const appimage = appimageMetainfo(shared);
  assert.match(
    appimage,
    /<launchable type="desktop-id">Donut\.desktop<\/launchable>/,
  );
  assert.doesNotMatch(appimage, /com\.donutbrowser\.DonutBrowser\.desktop/);
  assert.match(appimage, /<id>com\.donutbrowser\.DonutBrowser<\/id>/);
});

test("the URL types AppStream 0.15 rejects are left out, the others stay", () => {
  const appimage = appimageMetainfo(shared);
  assert.doesNotMatch(appimage, /type="(vcs-browser|contribute)"/);
  assert.match(appimage, /<url type="homepage">/);
  assert.match(appimage, /<url type="bugtracker">/);
});

test("a shared metainfo without the expected launchable is refused", () => {
  assert.throws(() => appimageMetainfo("<component></component>"));
});
