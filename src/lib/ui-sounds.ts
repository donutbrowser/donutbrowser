/**
 * Interface sounds: short, quiet, synthesized at play time. Nothing is
 * recorded or loaded, and a sound only plays while the window is in front.
 *
 * Every sound is a short phrase on one major pentatonic scale, so two sounds
 * that overlap never clash. A pack gives the phrases their timbre: the wave,
 * an overtone, how fast a note starts and fades, how bright it is, and how
 * much short room it has. The phrases are the same in every pack, so a sound
 * keeps its meaning when the pack changes. Every play shifts the pitch and
 * level a little, so a run of presses never sounds like one sample repeated.
 */

export type UiSound =
  | "tap"
  | "toggleOn"
  | "toggleOff"
  | "open"
  | "close"
  | "drop"
  | "success"
  | "error"
  | "warning"
  | "copy"
  | "trash"
  | "restore"
  | "launch"
  | "stop"
  | "synced"
  | "download"
  | "attention";

export type SoundCategory = "interface" | "feedback" | "events";

/** Which switch in Settings turns a sound on or off. */
export const SOUND_CATEGORY: Record<UiSound, SoundCategory> = {
  tap: "interface",
  toggleOn: "interface",
  toggleOff: "interface",
  open: "interface",
  close: "interface",
  drop: "interface",
  success: "feedback",
  error: "feedback",
  warning: "feedback",
  copy: "feedback",
  trash: "feedback",
  restore: "feedback",
  launch: "events",
  stop: "events",
  synced: "events",
  download: "events",
  attention: "events",
};

export const UI_SOUNDS = Object.keys(SOUND_CATEGORY) as UiSound[];

/** The categories in display order, each with the sound its preview plays. */
export const SOUND_CATEGORIES: readonly {
  id: SoundCategory;
  sample: UiSound;
}[] = [
  { id: "interface", sample: "toggleOn" },
  { id: "feedback", sample: "success" },
  { id: "events", sample: "launch" },
];

export type SoundPackId = "soft" | "crisp" | "retro";

/** The packs in display order. The first one is the default. */
export const SOUND_PACKS: readonly { id: SoundPackId }[] = [
  { id: "soft" },
  { id: "crisp" },
  { id: "retro" },
];

export const DEFAULT_SOUND_PACK: SoundPackId = "soft";
export const DEFAULT_SOUND_VOLUME = 60;

/** The sound fields of the app settings. A missing field is its default. */
export interface SoundSettings {
  ui_sounds?: boolean;
  ui_sound_volume?: number;
  ui_sound_interface?: boolean;
  ui_sound_feedback?: boolean;
  ui_sound_events?: boolean;
  ui_sound_pack?: string;
}

export interface SoundVoice {
  wave: "sine" | "triangle" | "square" | "noise";
  /** Hz at the start. Ignored for noise. */
  frequency: number;
  /** Hz at the end of the decay, for a slide. */
  endFrequency?: number;
  /** Seconds after the sound starts. */
  delay: number;
  attack: number;
  decay: number;
  /** Peak level before the volume. */
  peak: number;
  /** A band-pass that shapes a noise burst into a tick or a swish. */
  bandPass?: { frequency: number; q: number };
  /** -1 is left, 1 is right. */
  pan: number;
}

/** One sound in one pack, ready to schedule. */
export interface CompiledSound {
  voices: SoundVoice[];
  /** Cut-off of the low-pass that the whole sound goes through. */
  lowpass: number;
  /** Level sent into the short room. */
  room: number;
  /** How far one play may shift the pitch, as a ratio either way. */
  jitter: number;
}

interface Note {
  /** Steps on the pack's pentatonic scale: 0 is the root, 5 an octave up. */
  step: number;
  /** Seconds after the sound starts. */
  at: number;
  /** Seconds the note takes to fade. */
  length: number;
  /** 0 to 1, before the pack level. */
  level: number;
  /** Semitones the pitch slides over the note. */
  slide?: number;
}

interface Phrase {
  notes: Note[];
  /** A noise tick at the start, 0 to 1: the feel of a key going down. */
  touch?: number;
  /** A band of noise that swells and fades under the notes: a swish. */
  air?: { length: number; level: number; frequency: number };
  /** Pitch variation per play. A tick varies more than a tune. */
  jitter?: number;
}

/**
 * The phrases. Each sound has its own contour, so it is recognized without
 * looking: a press is one falling tick, a result goes up (success) or down
 * (error) a short way, a launch climbs four notes and a stop comes back down,
 * a warning repeats one unresolved note, and a copy repeats one high note.
 */
const PHRASES: Record<UiSound, Phrase> = {
  tap: {
    notes: [{ step: 4, at: 0, length: 0.026, level: 0.75, slide: -2 }],
    touch: 0.9,
    jitter: 0.035,
  },
  toggleOn: {
    notes: [
      { step: 4, at: 0, length: 0.03, level: 0.7 },
      { step: 7, at: 0.045, length: 0.045, level: 0.65 },
    ],
    touch: 0.5,
  },
  toggleOff: {
    notes: [
      { step: 7, at: 0, length: 0.03, level: 0.65 },
      { step: 4, at: 0.045, length: 0.045, level: 0.6 },
    ],
    touch: 0.5,
  },
  open: {
    notes: [{ step: 3, at: 0, length: 0.07, level: 0.3, slide: 2 }],
    air: { length: 0.07, level: 0.3, frequency: 1800 },
  },
  close: {
    notes: [{ step: 3, at: 0, length: 0.06, level: 0.28, slide: -2 }],
    air: { length: 0.06, level: 0.28, frequency: 1400 },
  },
  drop: {
    notes: [
      { step: -3, at: 0, length: 0.07, level: 0.9, slide: -3 },
      { step: 2, at: 0, length: 0.03, level: 0.25 },
    ],
    touch: 0.7,
    jitter: 0.02,
  },
  success: {
    notes: [
      { step: 3, at: 0, length: 0.08, level: 0.65 },
      { step: 5, at: 0.06, length: 0.09, level: 0.65 },
      { step: 7, at: 0.12, length: 0.18, level: 0.6 },
    ],
  },
  error: {
    notes: [
      { step: -2, at: 0, length: 0.11, level: 0.9, slide: -0.6 },
      { step: -3, at: 0.1, length: 0.17, level: 0.85, slide: -0.8 },
    ],
  },
  warning: {
    notes: [
      { step: 1, at: 0, length: 0.09, level: 0.7 },
      { step: 1, at: 0.12, length: 0.12, level: 0.65 },
    ],
  },
  copy: {
    notes: [
      { step: 7, at: 0, length: 0.03, level: 0.5 },
      { step: 7, at: 0.055, length: 0.04, level: 0.45 },
    ],
    touch: 0.35,
  },
  trash: {
    notes: [{ step: 0, at: 0, length: 0.12, level: 0.5, slide: -5 }],
    air: { length: 0.09, level: 0.5, frequency: 1100 },
  },
  restore: {
    notes: [
      { step: 0, at: 0, length: 0.1, level: 0.45, slide: 5 },
      { step: 7, at: 0.08, length: 0.12, level: 0.4 },
    ],
    air: { length: 0.07, level: 0.3, frequency: 1600 },
  },
  launch: {
    notes: [
      { step: 0, at: 0, length: 0.06, level: 0.5 },
      { step: 3, at: 0.04, length: 0.06, level: 0.55 },
      { step: 5, at: 0.08, length: 0.07, level: 0.55 },
      { step: 8, at: 0.12, length: 0.2, level: 0.5 },
    ],
  },
  stop: {
    notes: [
      { step: 5, at: 0, length: 0.07, level: 0.5 },
      { step: 3, at: 0.05, length: 0.08, level: 0.5 },
      { step: 0, at: 0.1, length: 0.16, level: 0.5 },
    ],
  },
  synced: {
    notes: [
      { step: 5, at: 0, length: 0.08, level: 0.5 },
      { step: 3, at: 0.07, length: 0.08, level: 0.45 },
      { step: 7, at: 0.14, length: 0.18, level: 0.5 },
    ],
  },
  download: {
    notes: [
      { step: 8, at: 0, length: 0.08, level: 0.45 },
      { step: 5, at: 0.08, length: 0.24, level: 0.6 },
    ],
    touch: 0.25,
  },
  attention: {
    notes: [
      { step: 5, at: 0, length: 0.12, level: 0.55 },
      { step: 9, at: 0.11, length: 0.26, level: 0.55 },
    ],
  },
};

interface Pack {
  /** Hz of step 0. */
  root: number;
  wave: "sine" | "triangle" | "square";
  /** One more sine on every note: its ratio to the note, its level, and how much sooner it fades. */
  partial: { ratio: number; level: number; length: number } | null;
  attack: number;
  /** Multiplies every note length. */
  length: number;
  /** Multiplies every note start, so a pack can play a phrase tighter. */
  tempo: number;
  /** Multiplies every peak: a square sounds louder than a sine at one peak. */
  level: number;
  touch: { frequency: number; q: number; level: number; length: number };
  lowpass: number;
  room: number;
  /** How far notes spread left (low) and right (high), 0 to 1. */
  width: number;
}

/**
 * Soft is round and warm: sines with a quiet octave, slow starts, a dark
 * low-pass and a little room. Crisp is a tone higher, short and glassy: a
 * bell-like overtone, quick starts, no low-pass to speak of and almost dry.
 * Retro is an old game console: square waves, filtered so they never buzz,
 * tight timing, centered and dry.
 */
const PACKS: Record<SoundPackId, Pack> = {
  soft: {
    root: 587.33,
    wave: "sine",
    partial: { ratio: 2, level: 0.2, length: 0.45 },
    attack: 0.004,
    length: 1,
    tempo: 1,
    level: 1,
    touch: { frequency: 2000, q: 0.8, level: 1, length: 0.012 },
    lowpass: 5200,
    room: 0.2,
    width: 0.35,
  },
  crisp: {
    root: 659.25,
    wave: "sine",
    partial: { ratio: 2.76, level: 0.3, length: 0.3 },
    attack: 0.0015,
    length: 0.7,
    tempo: 0.85,
    level: 0.8,
    touch: { frequency: 4200, q: 1.6, level: 1.1, length: 0.007 },
    lowpass: 11000,
    room: 0.1,
    width: 0.2,
  },
  retro: {
    root: 587.33,
    wave: "square",
    partial: null,
    attack: 0.002,
    length: 0.85,
    tempo: 0.9,
    level: 0.45,
    touch: { frequency: 5200, q: 0.6, level: 0.6, length: 0.008 },
    lowpass: 3000,
    room: 0,
    width: 0,
  },
};

const NOTE_PEAK = 0.08;
const TOUCH_PEAK = 0.045;
const AIR_PEAK = 0.06;
const PENTATONIC = [0, 2, 4, 7, 9];

function semitones(step: number) {
  const octave = Math.floor(step / 5);
  return octave * 12 + PENTATONIC[step - octave * 5];
}

/** The pitch of `step` on the major pentatonic scale of `root`. */
export function noteFrequency(root: number, step: number) {
  return root * 2 ** (semitones(step) / 12);
}

/** A known pack id, or the default pack. */
export function resolvePack(id: string | undefined): SoundPackId {
  return SOUND_PACKS.find((pack) => pack.id === id)?.id ?? DEFAULT_SOUND_PACK;
}

export function compileSound(sound: UiSound, packId?: string): CompiledSound {
  const pack = PACKS[resolvePack(packId)];
  const phrase = PHRASES[sound];
  const voices: SoundVoice[] = [];
  for (const note of phrase.notes) {
    const frequency = noteFrequency(pack.root, note.step);
    const slide = note.slide ? 2 ** (note.slide / 12) : null;
    const delay = note.at * pack.tempo;
    const decay = note.length * pack.length;
    const peak = NOTE_PEAK * note.level * pack.level;
    const pan = Math.max(-1, Math.min(1, (note.step - 4) / 8)) * pack.width;
    voices.push({
      wave: pack.wave,
      frequency,
      ...(slide ? { endFrequency: frequency * slide } : {}),
      delay,
      attack: pack.attack,
      decay,
      peak,
      pan,
    });
    if (pack.partial) {
      const { ratio, level, length } = pack.partial;
      voices.push({
        wave: "sine",
        frequency: frequency * ratio,
        ...(slide ? { endFrequency: frequency * ratio * slide } : {}),
        delay,
        attack: pack.attack,
        decay: decay * length,
        peak: peak * level,
        pan,
      });
    }
  }
  if (phrase.touch) {
    voices.push({
      wave: "noise",
      frequency: 0,
      delay: 0,
      attack: 0.001,
      decay: pack.touch.length,
      peak: TOUCH_PEAK * phrase.touch * pack.touch.level,
      bandPass: { frequency: pack.touch.frequency, q: pack.touch.q },
      pan: 0,
    });
  }
  if (phrase.air) {
    const { length, level, frequency } = phrase.air;
    voices.push({
      wave: "noise",
      frequency: 0,
      delay: 0,
      attack: length * 0.35,
      decay: length * 0.65,
      peak: AIR_PEAK * level,
      bandPass: { frequency, q: 0.7 },
      pan: 0,
    });
  }
  return {
    voices,
    lowpass: pack.lowpass,
    room: pack.room,
    jitter: phrase.jitter ?? 0.008,
  };
}

/** Seconds from the start of a sound to the end of its last voice. */
export function soundLength(compiled: CompiledSound) {
  return Math.max(
    ...compiled.voices.map((voice) => voice.delay + voice.attack + voice.decay),
  );
}

/** 0 to 100, whole numbers. Anything else is the default. */
export function clampVolume(volume: number | undefined) {
  if (typeof volume !== "number" || !Number.isFinite(volume)) {
    return DEFAULT_SOUND_VOLUME;
  }
  return Math.round(Math.max(0, Math.min(100, volume)));
}

/**
 * The output level for a volume. Loudness follows the square of the
 * setting, so the low half of the slider is usable, and the default is the
 * level the sounds were tuned at.
 */
export function volumeGain(volume: number) {
  const ratio = clampVolume(volume) / DEFAULT_SOUND_VOLUME;
  return 0.6 * ratio * ratio;
}

export interface ResolvedSoundSettings {
  enabled: boolean;
  volume: number;
  pack: SoundPackId;
  categories: Record<SoundCategory, boolean>;
}

export function resolveSoundSettings(
  settings: SoundSettings,
): ResolvedSoundSettings {
  return {
    enabled: settings.ui_sounds ?? true,
    volume: clampVolume(settings.ui_sound_volume),
    pack: resolvePack(settings.ui_sound_pack),
    categories: {
      interface: settings.ui_sound_interface ?? true,
      feedback: settings.ui_sound_feedback ?? true,
      events: settings.ui_sound_events ?? true,
    },
  };
}

/** What one play of `sound` would be, or null when the settings keep it silent. */
export function planSound(
  sound: UiSound,
  settings: SoundSettings | ResolvedSoundSettings,
): { compiled: CompiledSound; gain: number } | null {
  const resolved =
    "categories" in settings ? settings : resolveSoundSettings(settings);
  if (!resolved.enabled || !resolved.categories[SOUND_CATEGORY[sound]]) {
    return null;
  }
  const gain = volumeGain(resolved.volume);
  if (gain <= 0) return null;
  return { compiled: compileSound(sound, resolved.pack), gain };
}

/** The shortest time between two plays of one sound, in ms. */
export const SOUND_GAP_MS: Record<UiSound, number> = {
  tap: 35,
  toggleOn: 60,
  toggleOff: 60,
  open: 120,
  close: 120,
  drop: 150,
  copy: 250,
  trash: 400,
  restore: 400,
  success: 1200,
  error: 1200,
  warning: 1200,
  launch: 1500,
  stop: 1500,
  synced: 2000,
  download: 2000,
  attention: 3000,
};

/** What the sound picker needs to know about the control that was used. */
export interface ControlInfo {
  role: string | null;
  tag: string;
  /** `aria-checked` after the change, for switches and checkboxes. */
  checked: string | null;
  disabled: boolean;
  /** `data-sound="off"` on the control or a parent. */
  silenced: boolean;
}

const PRESSABLE_ROLES = new Set([
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "link",
]);
const TOGGLE_ROLES = new Set(["switch", "checkbox", "radio"]);

/**
 * `press` is a pointer going down: a button sounds at once, as a real one
 * does. `activate` is the click that follows, or a key press: a toggle sounds
 * then, once it holds its new state, and a button sounds only when a key
 * pressed it (a pointer already made it sound).
 */
export function soundForControl(
  control: ControlInfo,
  phase: "press" | "activate",
  byKeyboard: boolean,
): UiSound | null {
  if (control.disabled || control.silenced) return null;
  const role = control.role ?? implicitRole(control.tag);
  if (role && TOGGLE_ROLES.has(role)) {
    if (phase !== "activate") return null;
    return control.checked === "true" ? "toggleOn" : "toggleOff";
  }
  if (role && PRESSABLE_ROLES.has(role)) {
    if (phase === "press") return "tap";
    return byKeyboard ? "tap" : null;
  }
  return null;
}

function implicitRole(tag: string): string | null {
  switch (tag) {
    case "button":
    case "summary":
      return "button";
    case "a":
      return "link";
    default:
      return null;
  }
}

/** The elements that can make a sound; the closest one to the event wins. */
export const SOUND_CONTROL_SELECTOR = [
  "button",
  "summary",
  "a[href]",
  ...[...PRESSABLE_ROLES, ...TOGGLE_ROLES].map((role) => `[role="${role}"]`),
].join(",");

/**
 * How long after the window lost focus a sound the person caused may still
 * play: a launch hands the focus to the browser it opened before it returns.
 */
const HANDOFF_MS = 3000;
const PREVIEW_GAP_MS = 80;

let active = resolveSoundSettings({});
let lastBlurAt = Number.NEGATIVE_INFINITY;
let lastPreviewAt = Number.NEGATIVE_INFINITY;
const lastPlayed = new Map<UiSound, number>();
const lastBatch = new Map<UiSound, string | number>();

interface Engine {
  context: AudioContext;
  output: AudioNode;
  room: AudioNode | null;
  noise: AudioBuffer;
}
let engine: Engine | null = null;

/** Use the sound fields of the app settings from now on. */
export function applySoundSettings(settings: SoundSettings) {
  active = resolveSoundSettings(settings);
}

/** A short, dark room: decaying noise, different in each ear so it is wide. */
function roomImpulse(context: AudioContext) {
  const length = Math.ceil(context.sampleRate * 0.4);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const samples = buffer.getChannelData(channel);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      smooth += 0.25 * (Math.random() * 2 - 1 - smooth);
      samples[i] = smooth * Math.exp(-i / context.sampleRate / 0.085);
    }
  }
  return buffer;
}

function audio(): Engine | null {
  if (engine) return engine;
  const Context = window.AudioContext;
  if (!Context) return null;
  const context = new Context({ latencyHint: "interactive" });
  // A limiter keeps overlapping sounds at full volume from clipping.
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(context.destination);
  let room: AudioNode | null = null;
  try {
    const convolver = context.createConvolver();
    convolver.buffer = roomImpulse(context);
    convolver.connect(limiter);
    room = convolver;
  } catch {
    room = null;
  }
  const noise = context.createBuffer(
    1,
    Math.ceil(context.sampleRate * 0.25),
    context.sampleRate,
  );
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  engine = { context, output: limiter, room, noise };
  return engine;
}

function schedule(
  { context, noise }: Engine,
  voice: SoundVoice,
  at: number,
  pitch: number,
  bus: AudioNode,
) {
  const start = at + voice.delay;
  const end = start + voice.attack + voice.decay;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(voice.peak, start + voice.attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);

  let source: AudioScheduledSourceNode;
  if (voice.wave === "noise") {
    const buffer = context.createBufferSource();
    buffer.buffer = noise;
    // A different stretch of the noise each play.
    buffer.start(start, Math.random() * 0.1);
    source = buffer;
  } else {
    const oscillator = context.createOscillator();
    oscillator.type = voice.wave;
    oscillator.frequency.setValueAtTime(voice.frequency * pitch, start);
    if (voice.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(
        voice.endFrequency * pitch,
        end,
      );
    }
    oscillator.start(start);
    source = oscillator;
  }
  let last: AudioNode = source;
  if (voice.bandPass) {
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = voice.bandPass.frequency * pitch;
    band.Q.value = voice.bandPass.q;
    last.connect(band);
    last = band;
  }
  last.connect(envelope);
  last = envelope;
  if (voice.pan !== 0 && typeof context.createStereoPanner === "function") {
    const panner = context.createStereoPanner();
    panner.pan.value = voice.pan;
    last.connect(panner);
    last = panner;
  }
  last.connect(bus);
  source.stop(end + 0.02);
}

function render(compiled: CompiledSound, gain: number) {
  const sound = audio();
  if (!sound) return;
  const { context } = sound;
  if (context.state === "suspended") void context.resume();
  const pitch = 1 + (Math.random() - 0.5) * 2 * compiled.jitter;
  const at = context.currentTime + 0.004;
  const bus = context.createGain();
  bus.gain.value = gain * (1 + (Math.random() - 0.5) * 0.16);
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = compiled.lowpass;
  tone.Q.value = 0.5;
  bus.connect(tone);
  tone.connect(sound.output);
  if (sound.room && compiled.room > 0) {
    const send = context.createGain();
    send.gain.value = compiled.room;
    tone.connect(send);
    send.connect(sound.room);
  }
  for (const voice of compiled.voices) {
    schedule(sound, voice, at, pitch, bus);
  }
  window.setTimeout(
    () => tone.disconnect(),
    (soundLength(compiled) + 0.5) * 1000,
  );
}

function inFront(causedAt: number | undefined) {
  if (document.visibilityState !== "visible") return false;
  if (document.hasFocus()) return true;
  return (
    causedAt !== undefined &&
    lastBlurAt >= causedAt &&
    performance.now() - lastBlurAt < HANDOFF_MS
  );
}

export interface PlayOptions {
  /**
   * `performance.now()` when the person started the action. The sound still
   * plays when the action itself took the focus away a moment ago, as a
   * launch does when its browser window opens.
   */
  causedAt?: number;
  /** One id per bulk run: only the first play of a sound in a run sounds. */
  batch?: string | number;
}

export function playUiSound(sound: UiSound, options: PlayOptions = {}) {
  if (typeof window === "undefined") return;
  const plan = planSound(sound, active);
  if (!plan || !inFront(options.causedAt)) return;
  const { batch } = options;
  if (batch !== undefined && lastBatch.get(sound) === batch) return;
  const now = performance.now();
  if (
    now - (lastPlayed.get(sound) ?? Number.NEGATIVE_INFINITY) <
    SOUND_GAP_MS[sound]
  ) {
    return;
  }
  lastPlayed.set(sound, now);
  if (batch !== undefined) lastBatch.set(sound, batch);
  try {
    render(plan.compiled, plan.gain);
  } catch (error) {
    console.debug("UI sound not played:", error);
  }
}

/**
 * Plays `sound` with the draft's pack and volume, ignoring the master switch
 * and categories. Used by Settings previews.
 */
export function previewUiSound(sound: UiSound, draft: SoundSettings) {
  if (typeof window === "undefined") return;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  const settings = resolveSoundSettings(draft);
  const gain = volumeGain(settings.volume);
  if (gain <= 0) return;
  const now = performance.now();
  if (now - lastPreviewAt < PREVIEW_GAP_MS) return;
  lastPreviewAt = now;
  try {
    render(compileSound(sound, settings.pack), gain);
  } catch (error) {
    console.debug("UI sound preview not played:", error);
  }
}

function controlInfo(element: Element): ControlInfo {
  return {
    role: element.getAttribute("role"),
    tag: element.tagName.toLowerCase(),
    checked: element.getAttribute("aria-checked"),
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.getAttribute("data-disabled") === "true",
    silenced: element.closest('[data-sound="off"]') !== null,
  };
}

/**
 * Listen across the whole window for presses, toggles, and Escape closing a
 * dialog or page.
 */
export function installUiSounds(): () => void {
  const control = (target: EventTarget | null) =>
    target instanceof Element ? target.closest(SOUND_CONTROL_SELECTOR) : null;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const element = control(event.target);
    if (!element) return;
    const sound = soundForControl(controlInfo(element), "press", false);
    if (sound) playUiSound(sound);
  };
  const onClick = (event: MouseEvent) => {
    const element = control(event.target);
    if (!element) return;
    // A click with no pointer behind it (detail 0) came from Enter or Space.
    const byKeyboard = event.detail === 0;
    // Read a toggle's state once the app has drawn the change.
    requestAnimationFrame(() => {
      const sound = soundForControl(
        controlInfo(element),
        "activate",
        byKeyboard,
      );
      if (sound) playUiSound(sound);
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.repeat) return;
    const dialog =
      event.target instanceof Element
        ? event.target.closest('[role="dialog"],[role="alertdialog"]')
        : null;
    if (!dialog) return;
    requestAnimationFrame(() => {
      if (
        !dialog.isConnected ||
        dialog.getAttribute("data-state") === "closed"
      ) {
        playUiSound("close");
      }
    });
  };
  const onBlur = (event: FocusEvent) => {
    if (event.target === window) lastBlurAt = performance.now();
  };

  window.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    passive: true,
  });
  window.addEventListener("click", onClick, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, {
    capture: true,
    passive: true,
  });
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("click", onClick, { capture: true });
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("blur", onBlur);
  };
}
