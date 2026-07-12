# OJ Remote Submit Helper Lite

Chrome MV3 extension for browser-assisted remote submission in SDUSTJudge.

Supported targets:

- AtCoder
- Codeforces
- Codeforces Gym

This extension is used when SDUSTJudge remote judge runs in browser-submit
mode. It opens the target submit page in the user's browser, fills the form as
far as the site allows, waits for the user to finish any required verification
or final click, and then returns the detected submission id back to SDUSTJudge.

It does not send AtCoder or Codeforces cookies, CSRF tokens, passwords, or
login credentials to the SDUSTJudge backend.

## Directory layout

- `manifest.json`: extension manifest
- `background.js`: submit orchestration and site-specific automation
- `page-bridge.js`: bridge between SDUSTJudge page and extension runtime
- `CHANGELOG.md`: release history
- `PRIVACY.md`: data handling statement
- `RELEASE.md`: packaging and distribution notes
- `build-release.sh`: build a release zip for upload or manual distribution

## Installation for local testing

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this directory: `chrometools/oj-remote-submit-helper-lite`.
5. Log in to the target OJ in the same Chrome profile.
6. Trigger browser-submit mode from SDUSTJudge.

## Behavior by platform

### AtCoder

- Opens the AtCoder submit page.
- Waits for verification if needed.
- Fills task, language, and source code.
- Does not click the final `Submit` button on behalf of the user.
- Watches the page after the user's manual submit and returns the detected
  submission id and status.

### Codeforces

- Opens the contest or problemset submit page.
- Checks whether the current browser session appears logged in.
- Fills contest, problem, language, and source code.
- Does not bypass Cloudflare, Turnstile, or similar anti-bot checks.
- Does not click the final `Submit` button on behalf of the user.
- Watches the page after the user's manual submit and returns the detected
  submission id and status.

### Codeforces Gym

- Uses the same browser-submit flow as Codeforces.
- Supports Gym submit and submission URL detection when the remote source points
  to a Gym contest.

## Lite behavior

This lite variant keeps the final confirmation step manual on every supported
platform so the user interaction model stays consistent:

- AtCoder: fill only, manual final submit
- Codeforces: fill only, manual final submit
- Codeforces Gym: fill only, manual final submit

## Permissions

- `tabs`: open and inspect submit tabs created for the browser-submit flow
- `scripting`: run page-context helpers on supported submit pages
- `host_permissions`:
  - `https://atcoder.jp/*`
  - `https://codeforces.com/*`
  - `<all_urls>` for the SDUSTJudge page bridge and browser-submit entry page

If Chrome Web Store review requires tighter scope, the first place to refine is
the broad `<all_urls>` match used by the bridge.

## Packaging

Run:

```bash
./build-release.sh
```

The script writes a versioned zip into `dist/`.

## Distribution recommendation

- Primary public distribution: Chrome Web Store
- Internal testing / temporary distribution: release zip from the repository

## Related files in the main project

- `frontend/src/views/problems/Problems.vue`
- `frontend/src/views/problems/SolutionResult.vue`

Those pages trigger the browser-submit flow and wait for extension callbacks.
