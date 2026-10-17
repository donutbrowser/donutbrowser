import assert from "node:assert/strict";
import test from "node:test";
import {
  clampVolume,
  compileSound,
  DEFAULT_SOUND_PACK,
  DEFAULT_SOUND_VOLUME,
  noteFrequency,
  planSound,
  resolvePack,
  SOUND_CATEGORIES,
  SOUND_CATEGORY,
  SOUND_CONTROL_SELECTOR,
  SOUND_GAP_MS,
  SOUND_PACKS,
  soundForControl,
  soundLength,
  UI_SOUNDS,
  volumeGain,
} from "./ui-sounds.ts";

/**
 * What is pinned here is "never annoying": every sound in every pack is
 * short and quiet, starts without a click, can not repeat faster than its
 * gap, only the controls a person deliberately used make one, and every
 * setting that turns a sound off does turn it off.
 */

test("every sound exists in every pack, short, quiet and starting softly", () => {
  assert.ok(UI_SOUNDS.length >= 15);
  assert.deepEqual(
    SOUND_PACKS.map((pack) => pack.id),
    ["soft", "crisp", "retro"],
  );
  for (const { id: pack } of SOUND_PACKS) {
    for (const sound of UI_SOUNDS) {
      const name = `${pack}/${sound}`;
      const compiled = compileSound(sound, pack);
      assert.ok(compiled.voices.length > 0, name);
      assert.ok(
        soundLength(compiled) <= 0.45,
        `${name} lasts ${soundLength(compiled)} s`,
      );
      for (const voice of compiled.voices) {
        assert.ok(voice.peak > 0 && voice.peak <= 0.1, `${name} peak`);
        assert.ok(voice.attack >= 0.001, `${name} must not start with a click`);
        assert.ok(voice.pan >= -1 && voice.pan <= 1, `${name} pan`);
        if (voice.wave !== "noise") {
          assert.ok(
            voice.frequency >= 150 && voice.frequency <= 7000,
            `${name} pitch ${voice.frequency}`,
          );
        }
      }
      assert.ok(compiled.lowpass > 0 && compiled.room >= 0, name);
      assert.ok(SOUND_GAP_MS[sound] > 0, `${sound} needs a gap`);
    }
    assert.ok(
      soundLength(compileSound("tap", pack)) <= 0.04,
      `a ${pack} tap is a tick, not a tone`,
    );
  }
  assert.ok(
    SOUND_GAP_MS.error >= 1000 && SOUND_GAP_MS.success >= 1000,
    "a run of results makes one sound, not a burst",
  );
});

test("the packs sound different from each other", () => {
  const taps = SOUND_PACKS.map(({ id }) => compileSound("tap", id));
  const waves = new Set(taps.map((tap) => tap.voices[0].wave));
  const pitches = new Set(taps.map((tap) => tap.voices[0].frequency));
  assert.ok(waves.size > 1 || pitches.size > 1);
  assert.ok(new Set(taps.map((tap) => tap.lowpass)).size === taps.length);
});

test("the notes stay on one pentatonic scale", () => {
  assert.equal(noteFrequency(440, 0), 440);
  assert.equal(noteFrequency(440, 5), 880);
  assert.equal(noteFrequency(440, -5), 220);
  assert.ok(Math.abs(noteFrequency(440, 3) - 440 * 2 ** (7 / 12)) < 1e-9);
});

test("an unknown pack falls back to the default", () => {
  assert.equal(DEFAULT_SOUND_PACK, "soft");
  assert.equal(resolvePack("nope"), "soft");
  assert.equal(resolvePack(undefined), "soft");
  assert.equal(resolvePack("retro"), "retro");
  assert.deepEqual(compileSound("success", "nope"), compileSound("success"));
  assert.deepEqual(
    planSound("tap", { ui_sound_pack: "gone" })?.compiled,
    compileSound("tap", "soft"),
  );
});

test("every sound belongs to a category, and each category has a sample", () => {
  const ids = SOUND_CATEGORIES.map((category) => category.id);
  assert.deepEqual(ids, ["interface", "feedback", "events"]);
  for (const sound of UI_SOUNDS) {
    assert.ok(ids.includes(SOUND_CATEGORY[sound]), sound);
  }
  for (const { id, sample } of SOUND_CATEGORIES) {
    assert.equal(SOUND_CATEGORY[sample], id);
  }
});

test("the switches turn sounds off", () => {
  assert.ok(planSound("tap", {}), "everything is on by default");
  assert.equal(planSound("tap", { ui_sounds: false }), null);
  assert.equal(planSound("launch", { ui_sounds: false }), null);

  const noInterface = { ui_sound_interface: false };
  assert.equal(planSound("tap", noInterface), null);
  assert.equal(planSound("toggleOn", noInterface), null);
  assert.ok(planSound("success", noInterface));
  assert.ok(planSound("launch", noInterface));

  const noFeedback = { ui_sound_feedback: false };
  assert.equal(planSound("error", noFeedback), null);
  assert.equal(planSound("copy", noFeedback), null);
  assert.ok(planSound("tap", noFeedback));

  const noEvents = { ui_sound_events: false };
  assert.equal(planSound("launch", noEvents), null);
  assert.equal(planSound("attention", noEvents), null);
  assert.ok(planSound("success", noEvents));
});

test("volume 0 is silent, and the default is the tuned level", () => {
  assert.equal(DEFAULT_SOUND_VOLUME, 60);
  assert.equal(volumeGain(0), 0);
  assert.equal(planSound("success", { ui_sound_volume: 0 }), null);
  assert.equal(planSound("success", { ui_sound_volume: -20 }), null);
  assert.equal(volumeGain(DEFAULT_SOUND_VOLUME), 0.6);
  assert.ok(volumeGain(30) < volumeGain(60));
  assert.ok(volumeGain(100) > volumeGain(60));
  assert.equal(volumeGain(500), volumeGain(100));
  assert.equal(clampVolume(undefined), DEFAULT_SOUND_VOLUME);
  assert.equal(clampVolume(Number.NaN), DEFAULT_SOUND_VOLUME);
  assert.equal(clampVolume(42.6), 43);
  assert.equal(clampVolume(140), 100);
  assert.equal(
    planSound("tap", { ui_sound_volume: 100 })?.gain,
    volumeGain(100),
  );
});

const control = (overrides) => ({
  role: null,
  tag: "button",
  checked: null,
  disabled: false,
  silenced: false,
  ...overrides,
});

test("a button taps when pressed, and once only", () => {
  assert.equal(soundForControl(control({}), "press", false), "tap");
  assert.equal(
    soundForControl(control({}), "activate", false),
    null,
    "the click after a pointer press must not tap again",
  );
  assert.equal(soundForControl(control({}), "activate", true), "tap");
  assert.equal(
    soundForControl(control({ tag: "div", role: "option" }), "press", false),
    "tap",
  );
  assert.equal(soundForControl(control({ tag: "a" }), "press", false), "tap");
});

test("a toggle sounds its new state once it changed", () => {
  const on = control({ role: "switch", checked: "true" });
  const off = control({ role: "checkbox", checked: "false" });
  assert.equal(soundForControl(on, "press", false), null);
  assert.equal(soundForControl(on, "activate", false), "toggleOn");
  assert.equal(soundForControl(off, "activate", true), "toggleOff");
});

test("disabled, silenced and passive elements make no sound", () => {
  assert.equal(
    soundForControl(control({ disabled: true }), "press", false),
    null,
  );
  assert.equal(
    soundForControl(control({ silenced: true }), "press", false),
    null,
  );
  for (const tag of ["div", "input", "span", "textarea"]) {
    assert.equal(soundForControl(control({ tag }), "press", false), null, tag);
  }
  assert.ok(!SOUND_CONTROL_SELECTOR.includes("input"));
  assert.ok(SOUND_CONTROL_SELECTOR.includes('[role="switch"]'));
});
