import i18n, { type BackendModule, type ResourceKey } from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "zh", name: "Chinese", nativeName: "中文" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

const LANGUAGE_FALLBACKS: Record<string, string[]> = {
  uk: ["ru", "en"],
  be: ["ru", "en"],
  "zh-TW": ["zh", "en"],
  "zh-CN": ["zh", "en"],
  "zh-HK": ["zh", "en"],
  "pt-BR": ["pt", "en"],
  "pt-PT": ["pt", "en"],
  "es-MX": ["es", "en"],
  "es-AR": ["es", "en"],
  "es-ES": ["es", "en"],
  "fr-CA": ["fr", "en"],
  "fr-FR": ["fr", "en"],
  "de-DE": ["de", "en"],
  "de-AT": ["de", "en"],
  "de-CH": ["de", "en"],
  "de-LU": ["de", "en"],
  "de-LI": ["de", "en"],
  "vi-VN": ["vi", "en"],
};

export function getLanguageWithFallback(systemLocale: string): string {
  const baseLanguage = systemLocale.split(/[-_]/)[0].toLowerCase();

  if (SUPPORTED_LANGUAGES.some((lang) => lang.code === baseLanguage)) {
    return baseLanguage;
  }

  if (LANGUAGE_FALLBACKS[systemLocale]) {
    return LANGUAGE_FALLBACKS[systemLocale][0];
  }

  if (LANGUAGE_FALLBACKS[baseLanguage]) {
    return LANGUAGE_FALLBACKS[baseLanguage][0];
  }

  return "en";
}

// English ships in the main bundle as the fallback. Every other locale is its
// own chunk, loaded when `changeLanguage` asks for it.
const otherLocales = import.meta.glob<ResourceKey>(
  ["./locales/*.json", "!./locales/en.json"],
  { import: "default" },
);

const lazyLocales: BackendModule = {
  type: "backend",
  callbackApi: true,
  init() {},
  read(language, _namespace, callback) {
    const load = otherLocales[`./locales/${language}.json`];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (translation) => callback(null, translation),
      (error: Error) => callback(error, null),
    );
  },
};

i18n
  .use(lazyLocales)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: "en",
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });

export default i18n;
