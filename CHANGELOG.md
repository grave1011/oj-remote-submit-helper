# Changelog

## 0.2.2 - 2026-07-12

- Fix AtCoder manual-submit detection in lite mode
- Detect submission id from AtCoder submission list pages such as
  `/submissions/me`, not only from `/submissions/{id}` URL redirects
- Extend AtCoder browser-submit wait time to use the task timeout, matching the
  manual confirmation flow

## 0.2.1 - 2026-07-12

- Create the lite variant: `OJ Remote Submit Helper Lite`
- Change AtCoder browser-submit flow to match Codeforces and Gym:
  - fill form only
  - keep final submit manual
  - detect submission id after the user's confirm click
- Separate lite package identity and release zip name

## 0.2.0 - 2026-07-12

- Rename the extension for broader scope:
  - from `OJ Browser Submit`
  - to `OJ Remote Submit Helper`
- Rename the plugin directory from `atcoder-browser-submit` to
  `oj-remote-submit-helper`
- Clarify supported platforms:
  - AtCoder
  - Codeforces
  - Codeforces Gym
- Add release-oriented project files:
  - `PRIVACY.md`
  - `RELEASE.md`
  - `build-release.sh`
- Refresh the main README for publishing and distribution

## 0.1.4

- Browser-submit support for AtCoder
- Browser-assisted submit support for Codeforces
- Codeforces manual final-submit detection flow
- Initial Codeforces Gym handling in the shared Codeforces path
