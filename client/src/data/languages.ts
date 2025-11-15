// Curated Azure Cognitive Services locales (ASR/TTS) commonly used.
// Codes are BCP-47 (e.g., en-US, fr-CA). This list can be expanded.
export type Lang = { code: string; name: string };

export const LANGS: Lang[] = [
  { code: 'en-US', name: 'English (United States)' },
  { code: 'en-GB', name: 'English (United Kingdom)' },
  { code: 'en-CA', name: 'English (Canada)' },
  { code: 'en-AU', name: 'English (Australia)' },
  { code: 'fr-CA', name: 'French (Canada)' },
  { code: 'fr-FR', name: 'French (France)' },
  { code: 'es-ES', name: 'Spanish (Spain)' },
  { code: 'es-MX', name: 'Spanish (Mexico)' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)' },
  { code: 'de-DE', name: 'German (Germany)' },
  { code: 'it-IT', name: 'Italian (Italy)' },
  { code: 'nl-NL', name: 'Dutch (Netherlands)' },
  { code: 'sv-SE', name: 'Swedish (Sweden)' },
  { code: 'no-NO', name: 'Norwegian (Norway)' },
  { code: 'da-DK', name: 'Danish (Denmark)' },
  { code: 'fi-FI', name: 'Finnish (Finland)' },
  { code: 'pl-PL', name: 'Polish (Poland)' },
  { code: 'cs-CZ', name: 'Czech (Czechia)' },
  { code: 'sk-SK', name: 'Slovak (Slovakia)' },
  { code: 'ro-RO', name: 'Romanian (Romania)' },
  { code: 'hu-HU', name: 'Hungarian (Hungary)' },
  { code: 'bg-BG', name: 'Bulgarian (Bulgaria)' },
  { code: 'hr-HR', name: 'Croatian (Croatia)' },
  { code: 'sr-RS', name: 'Serbian (Serbia)' },
  { code: 'sl-SI', name: 'Slovenian (Slovenia)' },
  { code: 'lt-LT', name: 'Lithuanian (Lithuania)' },
  { code: 'lv-LV', name: 'Latvian (Latvia)' },
  { code: 'et-EE', name: 'Estonian (Estonia)' },
  { code: 'el-GR', name: 'Greek (Greece)' },
  { code: 'tr-TR', name: 'Turkish (Türkiye)' },
  { code: 'he-IL', name: 'Hebrew (Israel)' },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)' },
  { code: 'hi-IN', name: 'Hindi (India)' },
  { code: 'ta-IN', name: 'Tamil (India)' },
  { code: 'te-IN', name: 'Telugu (India)' },
  { code: 'th-TH', name: 'Thai (Thailand)' },
  { code: 'vi-VN', name: 'Vietnamese (Vietnam)' },
  { code: 'id-ID', name: 'Indonesian (Indonesia)' },
  { code: 'ms-MY', name: 'Malay (Malaysia)' },
  { code: 'zh-CN', name: 'Chinese (Mainland)' },
  { code: 'zh-TW', name: 'Chinese (Taiwan)' },
  { code: 'ja-JP', name: 'Japanese (Japan)' },
  { code: 'ko-KR', name: 'Korean (Korea)' },
  { code: 'ru-RU', name: 'Russian (Russia)' },
  { code: 'uk-UA', name: 'Ukrainian (Ukraine)' },
  { code: 'ca-ES', name: 'Catalan (Spain)' },
  { code: 'eu-ES', name: 'Basque (Spain)' },
  { code: 'gl-ES', name: 'Galician (Spain)' }
];

export function matchLangs(query: string, limit = 12): Lang[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return LANGS.slice(0, limit);
  const starts = LANGS.filter(l => l.code.toLowerCase().startsWith(q) || l.name.toLowerCase().startsWith(q));
  if (starts.length >= limit) return starts.slice(0, limit);
  const contains = LANGS.filter(l =>
    !starts.includes(l) && (l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
  );
  return [...starts, ...contains].slice(0, limit);
}

