import rawMap from "../language.json";

export const LANGUAGE_MAP = rawMap as Record<string, string>;

export const LANGUAGE_ITEMS = Object.entries(LANGUAGE_MAP)
  .map(([label, value]) => ({ label, value }))
  .sort((a, b) => a.label.localeCompare(b.label, "en"));

export const CODE_TO_LABEL = Object.entries(LANGUAGE_MAP).reduce<Record<string, string>>((acc, [label, value]) => {
  if (!(value in acc)) {
    acc[value] = label;
  }
  return acc;
}, {});

export const LABEL_TO_CODE = Object.entries(LANGUAGE_MAP).reduce<Record<string, string>>((acc, [label, value]) => {
  acc[label] = value;
  acc[label.toLowerCase()] = value;
  return acc;
}, {});
