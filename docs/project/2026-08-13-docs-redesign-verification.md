---
title: Documentation site visual verification
description: Desktop and mobile rendering baselines for the bilingual VitePress documentation site.
---

# Documentation site visual verification

These browser-rendered captures record the responsive baseline of the
documentation site. They are evidence for E2E-125, not a replacement for
rebuilding and checking the current site.

Each capture is produced from a local build served at the site's real base
path, so what the images show is what GitHub Pages serves:

```bash
VITEPRESS_BASE=/QianNing-Agent/ pnpm docs:build
VITEPRESS_BASE=/QianNing-Agent/ npx vitepress preview docs --port 4174
```

then `chrome --headless=new --hide-scrollbars --force-device-scale-factor=1
--window-size=<viewport> --virtual-time-budget=9000 --screenshot=<file> <url>`.

## Desktop landing page

The 1440×900 capture verifies the two-column hero and its product shot, the
three-column facts row that closes it, and the section rhythm below: the
four-step start path, the workflow grid, the local-data boundary, the runtime
layer list, the intent-based content map, and the closing call to action.

![QianNing Agent documentation landing page at 1440 by 900](/screenshots/docs-home-desktop.png)

## Mobile Chinese landing page

The 390×844 capture verifies that the translated hero leads the reading order,
the product shot follows the primary actions, and the page has no horizontal
overflow at the narrow viewport.

![QianNing Agent Chinese documentation landing page at 390 by 844](/screenshots/docs-home-mobile-zh.png)

## Chinese specification page

The desktop specification capture verifies the generated Chinese sidebar,
bounded reading column, source notice, and deep outline for a long runtime
contract.

![QianNing Agent Chinese specification page at 1440 by 900](/screenshots/docs-spec-zh-desktop.png)

## Verification contract

- Viewports: 1440×900 desktop and 390×844 mobile.
- Locales: English and Simplified Chinese.
- Appearance: the site locks to one appearance (`appearance: 'force-dark'` in
  the VitePress config), so the committed captures are dark. There is no light
  variant to capture.
- Product mark: every capture must show the QianNing Agent wordmark and the
  project's own icon in the header, never a third-party mark.
- Base path: the deployed site is served from `/<repo>/`; a capture is only
  valid when the product shot and the navigation render, which is what fails
  first if a component path skips the base.
- Overflow: the document root must match the viewport width; wide tables and
  code blocks may scroll only inside their own containers.
