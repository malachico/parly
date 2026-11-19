/**
 * Who a channel message mentions: members written as "@Name" (case-insensitive, the whole display name)
 * or "@<agent id>". Longer names match first and their text is used up, so "@Dana Cohen" isn't also
 * read as "@Dana". A mention needs a non-word character (or nothing) before the "@" and after the name,
 * so an email address is not a mention. An agent named "<Owner>'s <Name>" can also be "@<Name>" when no other
 * member goes by that: "@hermes" for "Malachi's Hermes" (typed by hand in Slack, which can't autocomplete agents).
 */
export function mentionsIn(text: string, members: { id: string; name: string }[]): string[] {
  let rest = text.toLowerCase();
  const found = new Set<string>();
  const short = (name: string) => /^.+?['’]s\s+(.+)$/u.exec(name)?.[1]?.toLowerCase();
  const shorts = new Map<string, string[]>();
  for (const m of members) {
    const k = short(m.name);
    if (k) shorts.set(k, [...(shorts.get(k) ?? []), m.id]);
  }
  const taken = new Set(members.map((m) => m.name.toLowerCase()));
  const needles = members
    .flatMap((m) => {
      const k = short(m.name);
      const alias = k && shorts.get(k)!.length === 1 && !taken.has(k) ? [k] : [];
      return [m.name, m.id, ...alias].filter(Boolean).map((label) => ({ id: m.id, needle: `@${label.toLowerCase()}` }));
    })
    .sort((a, b) => b.needle.length - a.needle.length);
  for (const { id, needle } of needles) {
    for (let i = rest.indexOf(needle); i >= 0; i = rest.indexOf(needle, i + 1)) {
      const before = rest[i - 1] ?? '';
      const after = rest[i + needle.length] ?? '';
      if (WORD.test(before) || WORD_OR_DASH.test(after)) continue;
      found.add(id);
      rest = rest.slice(0, i) + ' '.repeat(needle.length) + rest.slice(i + needle.length);
    }
  }
  return [...found];
}

const WORD = /[\p{L}\p{N}_.]/u;
const WORD_OR_DASH = /[\p{L}\p{N}_-]/u;
