# Privacy

`OJ Remote Submit Helper Lite` is a browser-assisted submission extension used
by SDUSTJudge.

## What it does

- Receives a remote submission task from the SDUSTJudge page
- Opens the target submit page in the browser
- Fills submit form fields where allowed by the target site
- Waits for the user to complete any required verification or final submit
- Detects the resulting remote submission id and reports it back to SDUSTJudge

## What it does not do

- It does not send AtCoder or Codeforces cookies to the SDUSTJudge backend.
- It does not send browser passwords, login credentials, or CSRF tokens to the
  SDUSTJudge backend.
- It does not bypass CAPTCHA, Turnstile, Cloudflare, or site verification
  requirements.
- It does not read unrelated browser pages for analytics or advertising.

## Data processed

For a browser-submit task, the extension may process:

- remote OJ platform type
- contest id or contest key
- problem id or problem index
- selected remote language id or language name
- source code that the user chose to submit
- detected remote submission id, URL, and status

This processing happens locally inside the user's browser session to complete
the requested submission flow.

## Network behavior

- Requests to AtCoder or Codeforces are made by the user's browser directly to
  those sites.
- The extension only sends task input and submission-result metadata back to
  the SDUSTJudge page runtime so SDUSTJudge can continue result polling.

## Contact / project owner

See the main SDUSTJudge project repository and deployment owner for support.
