# Changelog

## 0.3.1 — 2026-11-10

- Redact complete lifecycle-script credentials before truncating receipt text,
  preventing long quoted values and URL passwords from leaking fragments.
- Handle escaped quotes, unterminated quoted values and control characters
  consistently during credential redaction.
- Avoid repeated regular-expression backtracking on long dotted or hyphenated
  names, including names that repeat sensitive keywords without a value.
- Add regression coverage for these cases and for credentials following ordinary
  arguments or appearing inside wrapper assignments.

The test suite now contains 101 passing tests. This maintenance release adds no
dependencies and retains the browser-local, build-free workflow.
