// Languages the speech model understands, for the language picker. Codes are
// Whisper's (mostly ISO 639-1); names are what people call them in English.

export const LANGUAGES = Object.freeze({
  en: 'English', zh: 'Chinese', de: 'German', es: 'Spanish', ru: 'Russian', ko: 'Korean',
  fr: 'French', ja: 'Japanese', pt: 'Portuguese', tr: 'Turkish', pl: 'Polish', ca: 'Catalan',
  nl: 'Dutch', ar: 'Arabic', sv: 'Swedish', it: 'Italian', id: 'Indonesian', hi: 'Hindi',
  fi: 'Finnish', vi: 'Vietnamese', he: 'Hebrew', uk: 'Ukrainian', el: 'Greek', ms: 'Malay',
  cs: 'Czech', ro: 'Romanian', da: 'Danish', hu: 'Hungarian', ta: 'Tamil', no: 'Norwegian',
  th: 'Thai', ur: 'Urdu', hr: 'Croatian', bg: 'Bulgarian', lt: 'Lithuanian', la: 'Latin',
  mi: 'Maori', ml: 'Malayalam', cy: 'Welsh', sk: 'Slovak', te: 'Telugu', fa: 'Persian',
  lv: 'Latvian', bn: 'Bengali', sr: 'Serbian', az: 'Azerbaijani', sl: 'Slovenian', kn: 'Kannada',
  et: 'Estonian', mk: 'Macedonian', br: 'Breton', eu: 'Basque', is: 'Icelandic', hy: 'Armenian',
  ne: 'Nepali', mn: 'Mongolian', bs: 'Bosnian', kk: 'Kazakh', sq: 'Albanian', sw: 'Swahili',
  gl: 'Galician', mr: 'Marathi', pa: 'Punjabi', si: 'Sinhala', km: 'Khmer', sn: 'Shona',
  yo: 'Yoruba', so: 'Somali', af: 'Afrikaans', oc: 'Occitan', ka: 'Georgian', be: 'Belarusian',
  tg: 'Tajik', sd: 'Sindhi', gu: 'Gujarati', am: 'Amharic', yi: 'Yiddish', lo: 'Lao',
  uz: 'Uzbek', fo: 'Faroese', ht: 'Haitian Creole', ps: 'Pashto', tk: 'Turkmen', nn: 'Nynorsk',
  mt: 'Maltese', sa: 'Sanskrit', lb: 'Luxembourgish', my: 'Myanmar', bo: 'Tibetan', tl: 'Tagalog',
  mg: 'Malagasy', as: 'Assamese', tt: 'Tatar', haw: 'Hawaiian', ln: 'Lingala', ha: 'Hausa',
  ba: 'Bashkir', jw: 'Javanese', su: 'Sundanese', yue: 'Cantonese'
});

export function isLanguage(code) {
  return code === 'auto' || Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

export function languageName(code) {
  return code === 'auto' ? 'Detect automatically' : (LANGUAGES[code] ?? code);
}

// For a <select>: "Detect automatically" first, then A to Z.
export function languageChoices() {
  return [
    { code: 'auto', name: languageName('auto') },
    ...Object.entries(LANGUAGES)
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ];
}
