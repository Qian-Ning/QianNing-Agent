---
name: accessibility-and-keyboard
description: building or reviewing an interface, form, dialog, or interactive component
---

# Accessibility, starting with the keyboard

Accessibility is not a checklist bolted on at the end. Most of it falls out of
two decisions made early: use the element that already means what you want, and
make everything work without a mouse.

## The keyboard test

Put the mouse away and try to use the interface. That single exercise finds more
real problems than any automated checker.

- **Every action reachable, in a sensible order.** Focus order follows the visual
  order; a tab that jumps across the screen disorients everyone, not only screen
  reader users.
- **Visible focus, always.** Never remove the focus indicator without replacing
  it with something equally clear. `outline: none` with nothing in its place is
  the most common accessibility defect on the web, and it makes keyboard use
  impossible rather than merely awkward.
- **No keyboard traps.** If focus can enter something, it must be able to leave,
  except a deliberately modal dialog — and even that must close on Escape and
  return focus to where it came from.
- **Shortcuts do not fight the platform.** A key that conflicts with the browser,
  the OS, or a screen reader's own command takes control away from the people
  who need it most. If you bind single letters, provide a way to turn them off.
- **Focus moves deliberately.** After a dialog opens, after a route change, after
  a delete: put focus where the user's attention now is, and say what changed.

## Use the element that means it

A `div` with a click handler is not a button. It is a div: no keyboard
activation, no role, no focus, no disabled state.

- Buttons are buttons, links are links, and a control that submits is a button
  inside a form. The semantics, keyboard behavior, and screen reader
  announcement come free, and reimplementing them by hand reproduces them badly.
- Where a custom widget is genuinely needed, give it the role, the keyboard
  behavior, and the state that go with that role — not only the appearance.
- Headings are structured: one top-level heading, in order, and no level skipped
  for size. Screen reader users navigate by heading; a wall of styled paragraphs
  is unnavigable.

## Names for everything

- Every interactive control has an **accessible name**. An icon-only button has
  none unless you give it one, and it becomes "button" to a screen reader.
- Labels are bound to their inputs. A placeholder is not a label: it disappears
  as soon as someone types, and it is not reliably announced.
- Link and button text is meaningful out of context. "Click here" and "more" tell
  a screen reader user nothing when read as a list of links.
- Images: describe the function, not the file. Decorative images get an empty alt
  so they are skipped, rather than a filename read aloud.
- Where text and a control say the same thing, do not make the screen reader say
  it twice.

## Do not rely on one channel

- **Colour alone cannot carry meaning.** An error must have text or an icon as
  well as red; a status cannot be a coloured dot on its own. This also covers
  people using a monochrome display, a bright room, or a colour vision
  difference.
- **Contrast**: check text against its background, including text on images,
  disabled states, and placeholders. A design that looks elegant at 4.5:1 in your
  editor may not be.
- **Motion**: respect the reduced-motion preference. Parallax, auto-playing
  animation, and large transitions are vestibular triggers.
- **Sound and haptics** are never the only signal either.

## Dynamic content has to be announced

A result that appears silently is invisible to a screen reader.

- Use a live region for status text, results, and errors that appear
  asynchronously, and keep the announcement short.
- Do not announce everything; a chatty interface is as unusable as a silent one.
- On navigation, move focus and update the title, so the change is perceivable
  rather than merely visible.

## Forms and errors

- Error messages are next to the field they belong to, and programmatically
  associated with it, not only shown in a summary at the top.
- Say what is wrong and how to fix it, in the field's own terms. "Invalid" is not
  a message.
- Do not clear a form on a validation failure. Re-entering data is a real cost,
  paid by everyone and disproportionately by people using assistive technology.
- Group related controls with a fieldset and a legend where the group needs one.

## Text and layout must survive scaling

- Zoom to 200% without loss of content or function; never disable zoom.
- Use relative units so text scales with the user's setting, and let content
  reflow rather than clipping.
- Avoid fixed heights on containers that hold text; translated strings are
  longer, and so is the same string at a larger font size.

## Testing

- **Linters catch a fraction, and they lie in both directions** — a clean report
  is not a passing interface, and a warning is not always a real defect. Treat
  them as a start, not as evidence.
- Test with the keyboard, on the changed flow, every time.
- Test with a screen reader at least once per major feature. The experience of
  hearing your interface is not something you can infer.
- Include accessibility in the acceptance criteria for the feature, so it is
  verified like anything else rather than reviewed when someone remembers.

## Origin

QianNing Agent. Written in this repository; no third-party method, text, or document format is reproduced here.
