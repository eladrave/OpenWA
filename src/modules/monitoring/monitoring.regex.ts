import { RE2JS } from 're2js';

/** Compile user rules with the pure-JavaScript, non-backtracking RE2 port. Unicode is the default. */
export function compileMonitorRegex(pattern: string, flags = ''): RE2JS {
  let re2Flags = 0;
  if (flags.includes('i')) re2Flags |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes('m')) re2Flags |= RE2JS.MULTILINE;
  return RE2JS.compile(pattern, re2Flags);
}
