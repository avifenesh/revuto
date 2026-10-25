/**
 * Outbound text filter for everything revuto posts to GitHub.
 *
 * Review text is model output, and the model reads attacker-controlled PRs. So
 * before a comment leaves, prose is defused (no @-mentions that notify, no
 * HTML or hidden comments, no remote images, no ChatOps lines such as
 * `/approve`), and secrets are redacted everywhere, code blocks included. Code
 * blocks and inline code are otherwise left as written: mentions and tags
 * there do not render.
 */

const ZWSP = '\u200B';

/** Token shapes that must never be posted. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bABSK[A-Za-z0-9+/=]{40,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{32,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Environment variables whose values are credentials. */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_KEY$|BEARER|CREDENTIAL|PRIVATE/i;
const MIN_SECRET_VALUE = 12;

/** The credential values in an environment, longest first so one never masks part of another. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_VALUE)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const value of secretValues(env)) out = out.split(value).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Defuse one run of prose (no code inside). */
function defuseProse(text: string): string {
  return text
    // `@user` and `@org/team` notify; a zero-width space after @ keeps the text and drops the ping.
    .replace(/(^|[^A-Za-z0-9_`])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`)
    // Tags and comments (including a forged revuto marker) render or hide text: show them literally.
    .replace(/<(?=[A-Za-z!/?])/g, '&lt;')
    // A remote image loads (and can beacon) when the comment is viewed: keep it as a link.
    .replace(/!\[([^\]]*)\]\(/g, '[$1](')
    // ChatOps bots act on lines that start with a slash command.
    .replace(/^(\s*)\//gm, `$1${ZWSP}/`);
}

/** Split markdown into code (fenced blocks, inline spans) and prose, defusing only the prose. */
function defuseMarkdown(text: string): string {
  const parts: string[] = [];
  // Fenced blocks first, then inline code within the remaining prose.
  const fence = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g;
  let last = 0;
  for (const m of text.matchAll(fence)) {
    const start = m.index! + m[1]!.length;
    parts.push(defuseInline(text.slice(last, start)));
    parts.push(text.slice(start, m.index! + m[0].length));
    last = m.index! + m[0].length;
  }
  parts.push(defuseInline(text.slice(last)));
  return parts.join('');
}

function defuseInline(text: string): string {
  return text.split(/(`+[^`]*`+)/g).map((chunk, i) => (i % 2 === 1 ? chunk : defuseProse(chunk))).join('');
}

/**
 * Code fence languages that Obsidian plugins execute (Dataview JS, Templater,
 * JS Engine). A model-written note keeps the code, but as plain text.
 */
const EXECUTABLE_FENCE = /^([ \t]*)(```+|~~~+)[ \t]*(dataviewjs|dataview|js-engine|templater|tp)\b[^\n]*$/gim;

/**
 * A note revuto writes into the vault from model output (skills, the textbook):
 * HTML, remote images and plugin-executed code fences are defused and secrets
 * redacted, so opening the note in Obsidian loads or runs nothing.
 */
export function sanitizeNote(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return sanitizeOutbound(text.replace(EXECUTABLE_FENCE, '$1$2text'), env);
}

/** Everything revuto posts goes through this: defused prose, redacted secrets. */
export function sanitizeOutbound(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return defuseMarkdown(redactSecrets(text, env));
}
