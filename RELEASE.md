# Release Notes

This directory is structured for two distribution paths:

1. Chrome Web Store submission
2. Direct zip distribution for testing or internal deployment

## Before releasing

- Update `manifest.json` version
- Update `CHANGELOG.md`
- Re-check supported hosts and permission wording
- Verify browser-submit flows on:
  - AtCoder
  - Codeforces contest
  - Codeforces Gym

## Build a zip

Run:

```bash
./build-release.sh
```

Output:

- `dist/oj-remote-submit-helper-lite-v<version>.zip`

## Chrome Web Store preparation

Recommended listing name:

- `OJ Remote Submit Helper Lite`

Recommended summary:

- Browser-assisted remote submission helper for SDUSTJudge. Supports AtCoder,
  Codeforces, and Codeforces Gym, with manual final confirmation on every
  platform.

Review notes to prepare:

- Explain why `tabs` and `scripting` are needed
- Explain why the extension injects a bridge into the SDUSTJudge page
- Explain that the extension does not forward remote-site cookies or passwords
- Explain that Codeforces final submit remains manual

## Current gaps before store submission

- Broad `<all_urls>` scope may require extra review justification
- Icon and screenshot assets are not bundled in this directory
- Chrome Web Store listing screenshots should be prepared manually before final
  upload

## Suggested release channels

- Stable: Chrome Web Store
- Beta / internal: GitHub Release zip or project download page
