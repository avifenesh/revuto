/**
 * YAML front matter only. gray-matter also runs `---js` / `---javascript` front
 * matter through eval, so a note synced into the vault from elsewhere could run
 * code inside the daemon. Those notes are refused; YAML is parsed as before.
 */
import matter from 'gray-matter';

const refuse = (): never => { throw new Error('front matter engine disabled: YAML only'); };
const ENGINES = { js: refuse, javascript: refuse, coffee: refuse, coffeescript: refuse, cson: refuse };

export interface FrontMatter {
  readonly data: Record<string, unknown>;
  readonly content: string;
}

/** Parse YAML front matter, or null when the note declares another language. */
export function parseFrontMatter(raw: string): FrontMatter | null {
  // `---js`, `--- javascript`: a language after the opening fence selects an engine.
  if (/^---[^\S\r\n]*\S/.test(raw) && !/^----/.test(raw)) return null;
  try {
    const parsed = matter(raw, { engines: ENGINES } as unknown as Parameters<typeof matter>[1]);
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  } catch {
    return null;
  }
}
