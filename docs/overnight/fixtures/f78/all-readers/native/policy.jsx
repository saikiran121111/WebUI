export const settings = { retired: 917, active: 413 };
export function limit(key) { return settings[key] ?? 0; }
