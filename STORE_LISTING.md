# Chrome Web Store Listing

## Product name

OJ Remote Submit Helper Lite

## Short description

Browser-assisted remote submission helper for SDUSTJudge with manual final confirmation for AtCoder, Codeforces, and Codeforces Gym.

## Detailed description

OJ Remote Submit Helper Lite is a Chrome extension used by SDUSTJudge when a
remote problem runs in browser-submit mode.

The extension opens the target submit page, fills the task, language, and
source code where the site allows it, and then waits for the user to perform
the final confirmation step manually. After the user submits on the original
site, the extension detects the remote submission id and returns it to
SDUSTJudge so the platform can continue polling the final result.

Supported platforms:

- AtCoder
- Codeforces
- Codeforces Gym

Behavior:

- Opens the original submit page in the browser
- Fills problem, language, and source code
- Keeps the final submit action manual on every supported platform
- Detects the remote submission id after manual confirmation
- Returns the submission id back to SDUSTJudge for result polling

Security and privacy:

- Does not send AtCoder or Codeforces cookies to the SDUSTJudge backend
- Does not send passwords or login credentials to the SDUSTJudge backend
- Does not bypass CAPTCHA, Turnstile, Cloudflare, or site verification
- Only processes the data needed for the requested browser-submit task

## Category

Developer Tools

## Single purpose statement

This extension assists SDUSTJudge browser-submit tasks by opening supported
remote OJ submit pages, filling submission fields, and reporting the detected
remote submission id after the user manually confirms submission.

## Permission justification

### `tabs`

Used to open the remote OJ submit page, keep track of the tab created for the
submission flow, and observe URL changes after the user confirms submission.

### `scripting`

Used to run limited page-context helpers on supported remote submit pages so the
extension can fill form fields and inspect submission-result pages.

### Host permissions

- `https://atcoder.jp/*`
- `https://codeforces.com/*`
- `<all_urls>`

The AtCoder and Codeforces hosts are required for the supported submission
flows. The broad page bridge scope is used so the SDUSTJudge page can send
browser-submit tasks to the extension and receive the completion result.

## Support URL

https://github.com/grave1011/sdustjudge

## Homepage URL

https://github.com/grave1011/sdustjudge
