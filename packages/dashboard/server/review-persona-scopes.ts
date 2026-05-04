/**
 * review-persona-scopes — static scope table declaring which reviewer personas
 * run on which files, via path globs and content "sniff" regexes.
 */

export interface PersonaScope {
  /** Glob patterns; when omitted, persona runs on any path. */
  pathPatterns?: string[];
  /** At least one must match file contents; when omitted, no content filter. */
  contentSniffs?: RegExp[];
}

export const PERSONA_SCOPES: Record<string, PersonaScope> = {
  'sql-injection-reviewer': {
    pathPatterns: ['**/*.{sql,py,rb,go,ts,js,java,php,ex,exs,kt,scala}'],
    contentSniffs: [
      /\bSELECT\b/i,
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /db\.(query|exec|raw)\b/,
      /\.prepare\(/,
      /new\s+PreparedStatement/,
    ],
  },
  'xss-reviewer': {
    pathPatterns: ['**/*.{jsx,tsx,vue,svelte,html,ejs,erb,hbs,pug}'],
    contentSniffs: [
      /dangerouslySetInnerHTML/,
      /v-html\s*=/,
      /{{\{.*\}}}/,
      /innerHTML\s*=/,
    ],
  },
  'csrf-reviewer': {
    pathPatterns: ['**/*.{ts,js,py,rb,go,php,java}'],
    contentSniffs: [
      /app\.(post|put|patch|delete)\b/i,
      /router\.(post|put|patch|delete)\b/i,
      /@(Post|Put|Patch|Delete)Mapping/,
      /func.*http\.Handler/,
    ],
  },
  'path-traversal-reviewer': {
    contentSniffs: [
      /fs\.(read|write)File\b/,
      /os\.open\b/,
      /path\.(join|resolve)\(/,
      /\bopen\(['"].*\+/,
    ],
  },
  'race-condition-reviewer': {
    contentSniffs: [
      /\basync\b/,
      /\bawait\b/,
      /\bPromise\b/,
      /\bgo\s+func\b/,
      /goroutine/i,
      /\bmutex\b/i,
      /\bchannel\b/i,
      /ThreadPoolExecutor/,
      /asyncio\./,
    ],
  },
  'prototype-pollution-reviewer': {
    pathPatterns: ['**/*.{js,ts,jsx,tsx,mjs,cjs}'],
    contentSniffs: [
      /Object\.assign\(\s*\{\s*\}/,
      /_\.merge\b/,
      /lodash.*merge/,
      /\bObject\.prototype\b/,
      /__proto__/,
    ],
  },
  'auth-reviewer': {
    contentSniffs: [
      /(jwt|token|session|auth|cookie|bearer|oauth|saml)/i,
      /passport\./,
      /\bbcrypt\b/,
      /\bargon2\b/,
      /\bsha256\b/,
    ],
  },
  'crypto-reviewer': {
    contentSniffs: [
      /crypto\.(createHash|createCipher|randomBytes|pbkdf2)/,
      /\bMD5\b/i,
      /\bSHA1\b/i,
      /\bAES\b/,
      /\bRSA\b/,
      /\bHMAC\b/,
      /Buffer\.from\(.*base64/,
    ],
  },
  // Generic personas — empty scope means always run.
  'convention-reviewer': {},
  'edge-case-hunter': {},
  'perf-reviewer': {},
  'test-architect': {},
  'readability-reviewer': {},
};

export function listPersonaIds(): string[] {
  return Object.keys(PERSONA_SCOPES);
}
