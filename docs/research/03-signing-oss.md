# Shipping an OSS desktop app without paying for code signing — 2026

> Research report produced 2026-08-26. Case study: Flameshot. Also covers free/cheap
> signing options, per-OS costs of shipping unsigned, Electron-specific functional
> losses, and a recommendation ladder for easy-screenshare.

## Headline finding

The landscape shifted decisively in the last 12 months, and **the two platforms now diverge sharply**:

- **Windows has a genuinely free path.** SignPath Foundation gives qualifying OSS projects real OV code signing at no cost. Flameshot and Heroic both use it. It works.
- **macOS has no free path, and the workarounds are actively being closed.** Apple removed the right-click-Open bypass in macOS 15, and **Homebrew will disable every non-notarized cask on 2026-09-01** — Flameshot's cask is already marked deprecated. Ad-hoc signing, which used to be "good enough," is explicitly *not* enough for Homebrew and produces a dead-end dialog on Apple Silicon.

---

# 1. Flameshot case study

## Windows: signed, free, via SignPath — but through a second CI system

Flameshot's GitHub Actions Windows job does **no signing at all**. `.github/workflows/Windows-pack.yml` runs cpack (WIX → `.msi`, ZIP → portable), emits `sha256sum` files, and uploads. No `signtool`, no `CSC_LINK`, no certificate.

Signing lives in a **separate AppVeyor pipeline** (`appveyor.yml:30-37`), which builds the same artifacts and posts them to SignPath via a deploy webhook:

```yaml
deploy:
- provider: Webhook
  url: https://app.signpath.io/API/v1/042f605f-.../Integrations/AppVeyor?ProjectSlug=flameshot&SigningPolicySlug=test-signing
  #url: https://app.signpath.io/API/v1/042f605f-.../Integrations/AppVeyor?ProjectSlug=flameshot&SigningPolicySlug=release-signing
```

Two details worth noting: the **active policy is `test-signing`**, with `release-signing` commented out, and the README is candid that this is not automated (README.md:589):

> For Windows binaries, this program uses free code signing provided by SignPath.io, and a certificate by the SignPath Foundation.
>
> **Code signing is currently a manual process so not every patch release will be signed.**

This dates to v0.9 (docs/ReleaseNotes_0.9.md: "Thanks to SignPath we are able to offer digitally signed windows releases").

## macOS: ad-hoc signed only, and deliberately so

There is no Developer ID anywhere. `src/CMakeLists.txt:449-450` declares two cache variables that default to empty and are never set by CI:

```cmake
set(CODE_SIGN_IDENTITY "" CACHE STRING "Code signing identity (leave empty to skip signing)")
set(DMG_SIGN_IDENTITY "" CACHE STRING "DMG signing identity (leave empty to skip signing)")
```

So every macOS build takes the else-branch — `codesign --force --deep --sign -` on the bundle (`src/CMakeLists.txt:476` and again at `:498` after `macdeployqt` rewrites it), and `codesign --force --sign -` on the DMG (`packaging/macos/create_dmg.sh:71`). `.github/workflows/MacOS-pack.yml` never passes an identity.

**Why ad-hoc at all?** Not cosmetics — necessity. Maintainer borgmanJeremy in issue #4125:

> our v12.1 release flat out refused to run on apple silicon and traced it to a code signing issue. In this PR [#4020] I fixed code signing. Without this fix a dmg built on my PC will not run on your PC at all. Note it uses an ad-hoc signature, not a paid signature tied to my apple ID.

This is the general Apple Silicon rule: arm64 code with **no** signature is SIGKILLed on launch; ad-hoc satisfies the kernel but not Gatekeeper.

## What Flameshot tells macOS users

From README.md:388-398 and https://flameshot.org/docs/installation/installation-osx/ :

1. Right-click `flameshot.app` → Open → Open.
2. > On MacOs 15 and above, you will have to go to system settings -> privacy and security after doing this and click "Open Anyway"
3. Or: `sudo xattr -rd com.apple.quarantine /Applications/flameshot.app`

Note that `packaging/macos/create_dmg.sh:78-86` still prints the **pre-Sequoia** advice ("Right-clicking the app and selecting 'Open'… The warning only appears on first launch"). That guidance is now stale — a good illustration of how quickly this area rots.

## The maintainers' explicit refusal to pay

Issue #4125 — borgmanJeremy opens with "Who is paying the apple tax to sign them?" and concludes:

> In order to remove the security warning on MacOS the application needs to be both signed with a paid developer ID and notarized… **I am unaware of any way to remove that security warning without paying.**

Member mmahmoudian:

> I personally cannot comprehend why a FLOSS project should pay money out of their devs pocket annually to a FAANG company to get a virtual Monopoly tag… **On windows SignPath generously sponsors signed windows builds.** If we can find someone to do that on MacOS that would be the best option.

Critically, **they refuse donations entirely**: "the team decided we don't want to accept monetary donations." Costs are paid personally (domain) or by sponsors (SignPath, Namecheap, JetBrains). A Namecheap engineer offered to sign releases manually but could not share keys with CI, and it went nowhere. Issue #4417 closes the door: "this is not going to be signed."

## The 2026 development: Homebrew is evicting them

`flameshot` is **already deprecated in homebrew-cask and will be disabled 2026-09-01**. In Homebrew/homebrew-cask#222922, maintainer bevanjkay:

> We require casks in `homebrew-cask` to pass Gatekeeper (meaning they must be **codesigned and notarized**), we are in the process of deprecating all casks in `homebrew-cask` that don't meet this requirement, they will be disabled in September 2026.

borgmanJeremy's defense — "The package *is* signed now. Its just not signed with a paid developer account" — does not satisfy the policy: **ad-hoc does not pass Gatekeeper**. bevanjkay posted screenshots from an Apple Silicon MacBook Pro and noted:

> The system doesn't prompt you with any way to work around it — unless you know how Gatekeeper work on MacOS.

And SMillerDev, flatly: *"Unfortunately there is no way to get these without paying."*

Compounding it, Homebrew/brew#20755 deprecates `--no-quarantine` and `--quarantine` (announced 2025-09-23, same 2026-09-01 enforcement), removing the escape hatch that projects like Heroic used to put in their READMEs. Rationale cited: Apple silicon doesn't permit unsigned arm64 code, and Apple keeps making Gatekeeper overrides harder. Roughly 387 of 7,624 casks (~5%) are affected.

## Distribution channels Flameshot actually supports

| Platform | Channels |
|---|---|
| Windows | winget (`winget install flameshot`), Chocolatey, Scoop, MSI, portable ZIP |
| macOS | Homebrew cask (**deprecated, disabled 2026-09-01**), MacPorts, DMG |
| Linux | Flatpak, Snap, AppImage, Debian/Ubuntu (+PPA), Fedora, openSUSE, Arch (PKGBUILD), NixOS, Void, Solus, ALT, Docker |

The Linux surface is enormous and entirely unaffected by any of this. The Windows docs never mention SmartScreen. macOS is where all the pain is.

---

# 2. What unsigned actually costs your users, per OS

| | Unsigned / ad-hoc | User experience in 2026 | Escape hatch |
|---|---|---|---|
| **Windows** | No Authenticode signature | "Windows protected your PC" SmartScreen dialog on the downloaded installer. Publisher shows "Unknown publisher". Smart App Control (Win 11) may hard-block. | "More info" → "Run anyway"; or file Properties → Unblock. **Package managers largely sidestep it** (see below). |
| **macOS, no signature** | Nothing | arm64: SIGKILL on launch, app simply dies. Not a warning — a failure. | None. Must ad-hoc sign. |
| **macOS, ad-hoc signed** | `codesign --sign -` | "Apple could not verify [app] is free of malware." On macOS 15+ **no in-dialog bypass exists**. | System Settings → Privacy & Security → "Open Anyway" → admin password; or `xattr -rd com.apple.quarantine`. Homebrew cask: **banned from 2026-09-01**. |
| **macOS, Developer ID + notarized** | $99/yr | Clean first-launch prompt: "checked for malware, none found". | n/a |
| **Linux** | n/a | Nothing. No trust prompt in any format — deb, rpm, AppImage, Flatpak, Snap. | n/a |

### Windows: do package managers bypass SmartScreen?

Mostly yes, and this is the single most useful lever for an unsigned Windows build. The "Windows protected your PC" dialog is triggered by the **Mark-of-the-Web** (`Zone.Identifier` alternate data stream) that browsers attach to downloads via the `IAttachmentExecute` interface. winget, Scoop, and Chocolatey fetch over their own HTTP clients and generally do not apply MOTW, so the shell dialog doesn't fire. A LosslessCut contributor confirmed plainly that "winget doesn't have any issue with unsigned exes."

Caveats: **Smart App Control** on Windows 11 is a separate, stricter layer that can block unsigned binaries regardless of MOTW — Heroic hit exactly this because their installer was signed but the installed `Heroic.exe` was not (issue #5840). And a *newly* signed binary with no reputation history can still trigger SmartScreen until enough installs accumulate — Bruno lived through this for months (issue #4283).

### macOS: what changed in Sequoia

macOS 15 removed the Control-click → Open contextual override. Users must now go to System Settings → Privacy & Security, click a button, confirm, and enter an admin password. macOS 15.1 tightened it further. In practice most non-technical users will simply stop at the first dialog, since it offers no path forward.

---

# 3. Free and cheap signing options (2026 prices)

## Windows

| Option | Cost | Catch |
|---|---|---|
| **SignPath Foundation** (signpath.org/terms.html) | **Free** | OSI-approved license, **no dual-licensing, no proprietary components**, actively maintained, already released, documented. Certificate is issued to **"SignPath Foundation"** — that's your publisher name, not yours. **Every release needs manual approval.** Build scripts and CI config are code-reviewed. Windows only. Key in HSM; certs from Sectigo. |
| **Certum Open Source Code Signing** (shop.certum.eu) | **~€25–50/yr** | **Individuals only.** Identity verification required — in-person at a Registration Point, notarized proof, or full ID copy + utility bill + URL of your active OSS project. Cloud (SimplySign) version avoids the physical card+reader. From 2026-02-27 max validity is 459 days, so multi-year purchases need reissues. |
| **Azure Artifact Signing** (ex-Trusted Signing) | **$9.99/mo** Basic (5,000 signatures, 1 cert profile); $99.99/mo Premium | **US/Canada only for individuals**; orgs also EU/UK. **The 3-year-history requirement was dropped as of April 2026, and self-employed individuals can now apply.** Certs renew daily, valid 24h, timestamped so signatures outlive them. Works back to Win 7 SP1. Electron's own docs now recommend it. |
| **Traditional EV cert** | ~$200–400/yr | Hardware token / FIPS 140 L2 storage mandatory since June 2023. Instant SmartScreen reputation. |
| **Do nothing + ship via winget/Scoop/Choco** | Free | Works surprisingly well; Smart App Control is the residual risk. |

## macOS

**There is no free path. Confirmed from three independent directions:**

1. Flameshot maintainer: "I am unaware of any way to remove that security warning without paying."
2. Homebrew maintainer SMillerDev: "Unfortunately there is no way to get these without paying."
3. Heroic maintainer flavioislima, when a contributor insisted a free Apple ID would do: "Yes, looked at it but when I try to enroll the developer program it asks me to pay the bill. **There is no option to do it for free.**"

Notarization requires a Developer ID certificate, which requires Apple Developer Program membership at **$99/yr**. SignPath Foundation does not offer macOS signing.

**What ad-hoc signing (`codesign --sign -`) buys you:** the app *runs* on Apple Silicon instead of being SIGKILLed. That's it. It does not remove the Gatekeeper prompt, does not satisfy Homebrew, and does not fix the Electron API gaps below. For Electron specifically, `@electron/packager` applies ad-hoc signatures automatically on macOS, so you get this for free without thinking about it.

---

# 4. Electron-specific functional losses when unsigned on macOS

All four confirmed from Electron's official code-signing docs (https://www.electronjs.org/docs/latest/tutorial/code-signing):

- **`autoUpdater`** — "`Squirrel.Mac` requires the app to be signed for automatic updates to work at all." This is a hard failure, not a degradation.
- **`safeStorage`** — "Without a valid, consistent code signature, macOS may be unable to tell that two builds of your unsigned app are 'the same app'." Encrypted data becomes unreadable across builds.
- **`app.setLoginItemSettings()`** — "Login items can behave incorrectly (e.g. **silently failing to register**) when the app is not packaged, code signed, and notarized."
- **`cookieEncryption` fuse** — same Keychain dependency as `safeStorage`, same requirement.

Electron adds the general warning that "an unsigned or ad-hoc signed app may behave inconsistently, and issues that look like Electron bugs are often resolved by properly signing (and notarizing) your app."

**Real-world confirmation** — Heroic Games Launcher, issue #1316:

> flavioislima: "Since we are an open-source app we don't have a valid Development account for Apple, since it costs and it's not cheap… `Error: Could not get code signature for running application`" → "So I will just remove the info about auto-update on mac from the website."

and later, after buying the cert: **"Yes, we got a certificate from Apple so heroic auto updates now just fine."**

## Windows auto-update unsigned: yes, viable

`electron-updater` verifies the downloaded NSIS installer's Authenticode publisher against `publisherName`. For unsigned builds you set one flag. Ferdium does exactly this after losing their cert (electron-builder.yml):

```yaml
win:
  # Remove the verification for a signature to allow auto-update without signed certificate
  verifyUpdateCodeSignature: false
```

From PR #1244: "Setting the parameter `verifyUpdateCodeSignature` to false allows us to keep the auto-updating process even if the release is not signed."

Two caveats. NSIS updates run the installer, which triggers **UAC** and, if the file carries MOTW, SmartScreen — though electron-updater's download path typically doesn't set MOTW, so in practice it's usually just UAC. And there is a known **signature-verification bypass** disclosed by Doyensec (electron-builder#4701) where an error during verification still lets the update install — so don't treat verification as a security boundary you're relying on.

---

# 5. Comparison: four OSS Electron apps

| App | Windows | macOS | Auto-update on mac |
|---|---|---|---|
| **Heroic Games Launcher** | **SignPath Foundation, free** — via AppVeyor, same pattern as Flameshot | **Paid Developer ID + notarized** (since 2023-03) | Works — but only after they bought the cert |
| **LosslessCut** | **Nothing.** Deliberately unsigned | **Paid, signed + notarized** | No electron-updater at all |
| **Bruno** | **DigiCert EV** (commercial company) | Paid, signed + notarized | Not implemented; signing was the stated prerequisite |
| **Ferdium** | **Gave up** — cert expired 2023, never replaced | Paid, signed + notarized | Works on mac; Windows works only via `verifyUpdateCodeSignature: false` |

**The pattern is unambiguous: all four pay Apple's $99/yr. None of them skips macOS signing.** Windows is where they diverge, and the deciding factor is money rather than effort — Heroic got it free from SignPath, Bruno bought EV, Ferdium quit, LosslessCut monetizes instead.

Three stories worth reading in full:

**LosslessCut** turns the problem into a business model. mifi in discussion #678, on "Windows protected your PC":

> the losslesscut binary from github is not signed, so windows will complain. You can either ignore the warning and continue using the free version or you can buy a signed version in the Windows Store … (and support my work)

He priced it out in issue #218 ("Both which cost at least 200$ usd / year"), even opened an IssueHunt bounty for it, and settled on selling through the Microsoft Store and Mac App Store instead — his blog: *"I decided to charge a small price for the apps distributed through the Microsoft and Apple stores, to cover the costs I'm paying for the Apple and Microsoft fees."*

**Ferdium** documents the warnings better than anyone, precisely because they can't avoid them. From ferdium.org/faq: since Ferdium "is not recognised as a legal entity, it is not possible to obtain certificates under the organisation's name" — so their macOS cert is under maintainer **Ambroise Grau**'s personal name, and they tell Windows users to click "More Info", verify the publisher, then "safely click on 'Run anyway'". This is the model for honest unsigned-app documentation.

**Heroic** shows the cleanup cost of the Homebrew change: their README still says `brew install --cask --no-quarantine heroic`, unnecessary since they got notarized in 2023 and now referencing a flag Homebrew is deprecating.

---

# 6. Recommendation ladder for a new OSS Electron app

### v0 — friends only, $0

Ship unsigned on Windows and ad-hoc on macOS (Electron does the latter automatically). Don't build a signing pipeline before you have users.

Do these three things, which cost nothing:
- Publish SHA256 checksums alongside releases, as Flameshot does in its Windows workflow.
- Write the warning-bypass instructions into your README **before** the first bug report, with the **macOS 15+ path** (System Settings → Privacy & Security → Open Anyway), not the obsolete right-click advice. Ferdium's FAQ is the template.
- Assume no macOS auto-update. Use a "check for updates → open the release page" menu item, the way LosslessCut does. Don't fight Squirrel.Mac.

Also avoid `safeStorage`, the `cookieEncryption` fuse, and `app.setLoginItemSettings()` until you're signed — they fail quietly, which is worse than failing loudly.

### v1 — public releases, $0 on Windows

**Apply to SignPath Foundation.** Free, real OV signing, and it's what both Flameshot and Heroic use. Budget lead time for the application and accept two constraints: the publisher name will read "SignPath Foundation," and every release needs manual approval, so patch releases may ship unsigned (Flameshot says so outright in their README).

Simultaneously, **get into winget and Scoop**. This is the highest-leverage free move on Windows — it routes most users around SmartScreen entirely, and it's how Flameshot serves Windows users despite manual, intermittent signing.

If SignPath rejects you or the manual-approval cadence doesn't fit, **Azure Artifact Signing at $9.99/mo** is now the strongest paid option and got materially more accessible in April 2026 when the 3-year-history requirement was dropped and self-employed individuals became eligible — provided you're in the US or Canada. Otherwise **Certum's OSS cert at ~€25–50/yr**, accepting the ID-verification hassle.

### v2 — you have macOS users who matter: pay the $99

There is no way around this, and the deadline is concrete. If you want to be in Homebrew at all, you must be **codesigned and notarized by 2026-09-01**. Ad-hoc will not pass. `--no-quarantine` is being removed, so users can't work around it either.

What $99/yr buys, beyond the clean prompt: working `autoUpdater`, working `safeStorage`, working login items, and eligibility for Homebrew cask. Set `hardenedRuntime: true`, entitlements, and either electron-builder's `notarize` or a custom `afterSign` hook with `@electron/notarize`.

Note the entity problem before you enroll: Ferdium couldn't get an org-named cert because the project isn't a legal entity, so it's under a maintainer's personal name. Decide whose name is on it up front.

### The trap to avoid

Flameshot's position is defensible for a project that refuses donations on principle, but it has a real cost that just came due: they are being removed from the default macOS package manager, and they had no funding mechanism to prevent it. If you're not ideologically committed to refusing money, **enable GitHub Sponsors early** — $99/yr is roughly one modest sponsor, and it's the difference between Heroic's outcome and Flameshot's.

---

## Sources

- Flameshot: https://github.com/flameshot-org/flameshot · README https://github.com/flameshot-org/flameshot/blob/master/README.md · issue #4125 https://github.com/flameshot-org/flameshot/issues/4125 · issue #4417 https://github.com/flameshot-org/flameshot/issues/4417 · PR #4020 https://github.com/flameshot-org/flameshot/pull/4020
- Flameshot docs: https://flameshot.org/docs/installation/installation-osx/ · https://flameshot.org/docs/installation/installation-windows/
- Homebrew: https://github.com/Homebrew/homebrew-cask/issues/222922 · https://github.com/Homebrew/brew/issues/20755 · https://github.com/orgs/Homebrew/discussions/6482 · https://workbrew.com/blog/homebrew-5-0-0
- SignPath: https://signpath.org/terms.html · https://signpath.io/solutions/open-source-community
- Certum: https://shop.certum.eu/code-signing.html · https://www.certum.eu/en/code-signing-certificates/
- Azure Artifact Signing: https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ · https://azure.microsoft.com/en-us/products/artifact-signing · https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554 · https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- Electron: https://www.electronjs.org/docs/latest/tutorial/code-signing · https://www.electron.build/docs/features/auto-update/ · https://github.com/electron-userland/electron-builder/issues/4701
- macOS Sequoia Gatekeeper: https://mjtsai.com/blog/2024/07/05/sequoia-removes-gatekeeper-contextual-menu-override/ · https://www.osnews.com/story/141055/bug-or-intentional-macos-15-1-completely-removes-ability-to-launch-unsigned-applications/ · https://support.apple.com/en-us/102445
- Mark-of-the-Web: https://www.outflank.nl/blog/2020/03/30/mark-of-the-web-from-a-red-teams-perspective/ · https://attack.mitre.org/techniques/T1553/005/
- LosslessCut: https://github.com/mifi/lossless-cut/discussions/678 · https://github.com/mifi/lossless-cut/issues/240 · https://github.com/mifi/lossless-cut/issues/218 · https://mifi.no/blog/losslesscut-now-on-the-mac-app-store-and-microsoft-store/
- Heroic: https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/blob/main/appveyor.yml · https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/issues/1316 · https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/issues/2411 · https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/pull/2553 · https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/issues/5840
- Bruno: https://github.com/usebruno/bruno/issues/4283 · https://github.com/usebruno/bruno/blob/main/packages/bruno-electron/electron-builder-config.js
- Ferdium: https://github.com/ferdium/ferdium-app/pull/1244 · https://github.com/ferdium/ferdium-app/blob/develop/electron-builder.yml · https://ferdium.org/faq
