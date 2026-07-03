/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  // Every rule below is level 1 (warning) or 0 (off) so a commit is NEVER
  // blocked. A plain `git commit -m "message"` always succeeds; conventional
  // commits (feat:/fix:/chore: …) are still encouraged and surfaced as hints.
  rules: {
    'type-enum': [
      1,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'chore',
        'revert',
        'ci',
        'build',
      ],
    ],
    // Don't require a type prefix or a non-empty subject — allow any message.
    'type-empty': [0],
    'subject-empty': [0],
    // Allow any casing (Uppercase, Sentence case, etc.).
    'subject-case': [0],
    // Warn past 100 chars but never reject.
    'header-max-length': [1, 'always', 100],
  },
};
