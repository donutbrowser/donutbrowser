import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appimageMetainfo, SHARED_METAINFO } from "./appimage-metainfo.mjs";

const shared = readFileSync(SHARED_METAINFO, "utf8");

test("the AppImage's metainfo is launched by the AppImage's desktop entry", () => {
  const appimage = appimageMetainfo(shared, "1.2.3", "2026-10-30");
  assert.match(
    appimage,
    /<launchable type="desktop-id">Donut\.desktop<\/launchable>/,
  );
  assert.doesNotMatch(appimage, /com\.donutbrowser\.DonutBrowser\.desktop/);
  assert.match(appimage, /<id>com\.donutbrowser\.DonutBrowser<\/id>/);
});

test("the URL types AppStream 0.15 rejects are left out, the others stay", () => {
  const appimage = appimageMetainfo(shared, "1.2.3", "2026-10-30");
  assert.doesNotMatch(appimage, /type="(vcs-browser|contribute)"/);
  assert.match(appimage, /<url type="homepage">/);
  assert.match(appimage, /<url type="bugtracker">/);
});

test("a shared metainfo without the expected launchable is refused", () => {
  assert.throws(() =>
    appimageMetainfo("<component></component>", "1.2.3", "2026-10-30"),
  );
});

test("the bundled version is the newest release, and only once", () => {
  const appimage = appimageMetainfo(shared, "1.2.3", "2026-10-30");
  assert.match(
    appimage,
    /<releases>\n {4}<release version="1\.2\.3" date="2026-10-30" \/>\n {4}<release /,
  );
  const released = shared.replace(
    "<releases>\n",
    '<releases>\n    <release version="1.2.3" date="2026-10-29" />\n',
  );
  const again = appimageMetainfo(released, "1.2.3", "2026-10-30");
  assert.equal(again.match(/version="1\.2\.3"/g).length, 1);
  assert.match(again, /date="2026-10-29"/);
});
