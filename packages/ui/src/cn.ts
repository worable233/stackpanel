type ClassValue =
  | string
  | number
  | false
  | null
  | undefined
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

/** Minimal class joiner for the magicui component set. */
export function cn(...inputs: ClassValue[]): string {
  const parts: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === 'string' || typeof input === 'number') {
      parts.push(String(input));
    } else if (Array.isArray(input)) {
      parts.push(cn(...input));
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (value) parts.push(key);
      }
    }
  }
  return parts.join(' ');
}
