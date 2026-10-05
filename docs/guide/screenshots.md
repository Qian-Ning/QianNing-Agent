---
title: Screens
description: Every QianNing Agent surface, captured from the running app.
---

# Screens

Every frame below comes from the capture rig that backs the
[E2E test plan](/spec/06-delivery/04-e2e-test-plan): the app runs with
`PI_DESKTOP_CAPTURE=1` against a throwaway data directory, drives itself through
each surface, and writes the PNGs that `scripts/publish-screenshots.py` converts
for this page. The screenshots therefore show the shipped shell rather than a
mockup, including the empty states a fresh install starts from.

Session titles and transcripts come from the capture fixture, so the chrome is
English while the sample conversation is Chinese. The
[中文版本](/zh-CN/guide/screenshots) shows the same surfaces with Chinese chrome.

## Home and conversation

The home screen is the first surface a new install shows: a hero, the composer,
and the sidebar with sessions grouped by project.

![QianNing Agent home in the light theme](../public/screenshots/app/en/home-light.webp)

![QianNing Agent home in the dark theme](../public/screenshots/app/en/home-dark.webp)

A conversation streams into the transcript with a minimap rail on the right;
hovering the rail magnifies the markers and previews the message under the
cursor.

![A conversation with the minimap rail](../public/screenshots/app/en/minimap.webp)

![The minimap rail magnified under the cursor](../public/screenshots/app/en/minimap-hover.webp)

The Composer's model × reasoning chip switches the model for the session. In the
composer, `/` opens the command menu and `@` opens the file reference menu.

![The model and reasoning menu in the Composer](../public/screenshots/app/en/model-menu.webp)

![The slash command menu in the composer](../public/screenshots/app/en/composer-slash.webp)

![The at-mention file menu in the composer](../public/screenshots/app/en/composer-at.webp)

## Work panels

An agent Write/Edit never opens the panel. The panel appears when the user opens
it, or when a file, URL, browser-preview, or plan-approval artifact opens its
tab. The frames below are the panels without an active workspace, which is the
state a conversation starts in.

![The review panel](../public/screenshots/app/en/panel-review.webp)

![The browser preview panel](../public/screenshots/app/en/panel-browser.webp)

![The file browser panel](../public/screenshots/app/en/panel-files.webp)

## Destinations

The project archive and scheduled tasks are full-page destinations.

![The project archive](../public/screenshots/app/en/project-archive-live.webp)

![The project archive in the dark theme](../public/screenshots/app/en/dark-project-archive.webp)

![Scheduled tasks](../public/screenshots/app/en/scheduled-live.webp)

## Notifications and toasts

The notification inbox keeps a durable record of finished work, permission
requests, and update notices. Toasts cover the transient end of the same range.

![The notification inbox in the light theme](../public/screenshots/app/en/notifications-light.webp)

![The notification inbox in the dark theme](../public/screenshots/app/en/notifications-dark.webp)

![The notification popover in a narrow window](../public/screenshots/app/en/notifications-narrow.webp)

![Success, warning, and error toasts in the light theme](../public/screenshots/app/en/toasts-light.webp)

![Success, warning, and error toasts in the dark theme](../public/screenshots/app/en/toasts-dark.webp)

## Global search

`⌘K` opens one dialog over sessions, pages, settings rows, and commands.
Choosing a settings hit navigates to the tab and flashes the row.

![Global search with recent sessions](../public/screenshots/app/en/search.webp)

![Global search matching sessions](../public/screenshots/app/en/search-query.webp)

![Global search matching settings rows](../public/screenshots/app/en/search-settings.webp)

![Global search matching destination pages](../public/screenshots/app/en/search-pages.webp)

![Global search in the dark theme](../public/screenshots/app/en/search-dark.webp)

## Plugins

Installed plugins, the marketplace, and the package workflow live on the plugins
destination.

![Installed plugins](../public/screenshots/app/en/plugins-live.webp)

![The plugin marketplace](../public/screenshots/app/en/plugins-market.webp)

![The plugins page menu](../public/screenshots/app/en/plugins-menu.webp)

![The per-plugin row menu](../public/screenshots/app/en/plugins-row-menu.webp)

![The new plugin template dialog](../public/screenshots/app/en/plugins-template.webp)

## Extensions

MCP servers, Skills, and Subagents are managed independently of plugins, each
with global or project-scoped activation.

![MCP servers](../public/screenshots/app/en/extensions-mcp.webp)

![The activation scope selector](../public/screenshots/app/en/extensions-scope.webp)

![The MCP server editor](../public/screenshots/app/en/extensions-mcp-editor.webp)

![Skills](../public/screenshots/app/en/extensions-skills.webp)

![Subagents](../public/screenshots/app/en/extensions-subagents.webp)

![Subagents in the dark theme](../public/screenshots/app/en/extensions-subagents-dark.webp)

![MCP servers in the dark theme](../public/screenshots/app/en/extensions-mcp-dark.webp)

## Settings

Settings is a full-page destination with a searchable tab rail.

![Basics — language, theme, and appearance](../public/screenshots/app/en/settings-live.webp)

![Basics in the dark theme](../public/screenshots/app/en/dark-settings.webp)

![Model configuration provider defaults](../public/screenshots/app/en/settings-models.webp)

![Extensions marketplace with the catalog source picker](../public/screenshots/app/en/settings-extensions.webp)

## Regenerating these frames

Build the renderer, make sure `target/debug/pi-desktop-host-core` exists, then run
the app once per locale against a throwaway data directory. The rig paints the
sidebar from whatever profile it is handed, so running it against your own
profile publishes your own project and session titles.

```bash
pnpm --filter @pi-desktop/desktop build
mkdir -p /tmp/shots-en /tmp/shots-zh

# English pass, then the Chinese pass; each gets its own source directory so the
# second run does not overwrite the first.
cd apps/desktop
PI_DESKTOP_CAPTURE=1 PI_DESKTOP_DATA_DIR=$(mktemp -d) \
  ELECTRON_RENDERER_URL= ./node_modules/.bin/electron . --lang=en-US
mv /tmp/codex-screens/*.png /tmp/shots-en/

PI_DESKTOP_CAPTURE=1 PI_DESKTOP_DATA_DIR=$(mktemp -d) \
  ELECTRON_RENDERER_URL= ./node_modules/.bin/electron . --lang=zh-CN
mv /tmp/codex-screens/*.png /tmp/shots-zh/

python3 scripts/publish-screenshots.py --source /tmp/shots-en --locale en
python3 scripts/publish-screenshots.py --source /tmp/shots-zh --locale zh
```

The rig prints `CAPTURE_DONE` when the last scene is written and then leaves the
window open, so quit the app before the next pass. One pass feeds three stores:
this page's gallery, the README frames in `docs/image/readme/`, and the
docs-site landing frames in `docs/public/readme/`. Only the publisher writes
them — no screenshot in any of the three is hand-made, and `screenshot-catalog`
holds the three sets to the two scene lists in the script.
