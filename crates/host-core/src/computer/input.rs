//! Pure planning for the events the computer-control layer injects.
//!
//! Kept free of platform calls so the rules — which characters become which
//! keystrokes, and which steps activate a window — are unit-tested on any
//! build host.

use super::{Point, Rect};

/// Virtual-key code for Return, as Windows defines it.
pub const VK_RETURN: u16 = 0x0D;

/// Virtual-key code for Tab, as Windows defines it.
pub const VK_TAB: u16 = 0x09;

/// How far below a window's top edge the activation click lands.
///
/// Deep enough to clear the resize border and sit in the title bar of a normal
/// window; shallow enough that a short window still has a point below its top
/// edge.
pub const TITLE_BAR_PROBE_Y: i32 = 24;

/// One keystroke the input layer will inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStroke {
    /// A UTF-16 code unit sent with `KEYEVENTF_UNICODE`, which types the
    /// character itself and bypasses whatever keyboard layout is active.
    Unicode(u16),
    /// A virtual-key press and release, for keys text cannot express.
    Virtual(u16),
}

/// Turn text into the keystrokes that type it.
///
/// Line endings are normalised first: `\r\n` collapses to one Return, and a
/// lone `\r` is honoured as Return rather than dropped, so text read off a
/// file neither submits twice nor swallows a break that was really there.
///
/// Every other character becomes one UTF-16 code unit, including both halves
/// of a surrogate pair for a character outside the BMP — that pair is what a
/// `KEYEVENTF_UNICODE` stream is supposed to carry, so counting characters
/// rather than code units would corrupt the very characters it was trying to
/// preserve.
pub fn plan_text_input(text: &str) -> Vec<KeyStroke> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut plan = Vec::with_capacity(normalized.len());
    for character in normalized.chars() {
        match character {
            '\n' => plan.push(KeyStroke::Virtual(VK_RETURN)),
            '\t' => plan.push(KeyStroke::Virtual(VK_TAB)),
            _ => {
                let mut units = [0u16; 2];
                for unit in character.encode_utf16(&mut units) {
                    plan.push(KeyStroke::Unicode(*unit));
                }
            }
        }
    }
    plan
}

/// One step of the sequence that activates a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationStep {
    /// Raise the window above everything without focusing it.
    RaiseTopmost,
    /// The click on the title bar. Windows only lets a process change the
    /// foreground window on a real input event, so this click is not a
    /// convenience — it is the gesture that makes the activation stick.
    ClickTitleBar(Point),
    /// Drop the window back out of the always-on-top band.
    RestoreZOrder,
}

/// The steps that activate the window occupying `bounds`.
///
/// Returns nothing for a window with no interior to click. Raising such a
/// window and leaving it topmost would be worse than doing nothing: the caller
/// would have a window pinned over the desktop and no way to tell that the
/// activation had failed.
pub fn activation_plan(bounds: Rect) -> Vec<ActivationStep> {
    if bounds.width() < 2 || bounds.height() < 2 {
        return Vec::new();
    }
    // Stay one pixel below the top edge so the click cannot land on the
    // resize border, and never past the window's middle so a short window
    // still gets a title-bar point.
    let offset = TITLE_BAR_PROBE_Y.min((bounds.height() - 1) / 2).max(1);
    let point = Point::new(bounds.left + bounds.width() / 2, bounds.top + offset);
    vec![
        ActivationStep::RaiseTopmost,
        ActivationStep::ClickTitleBar(point),
        ActivationStep::RestoreZOrder,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_becomes_one_unicode_stroke_per_character() {
        assert_eq!(
            plan_text_input("abc"),
            vec![
                KeyStroke::Unicode(u16::from(b'a')),
                KeyStroke::Unicode(u16::from(b'b')),
                KeyStroke::Unicode(u16::from(b'c')),
            ]
        );
    }

    #[test]
    fn a_newline_becomes_return_so_a_form_can_be_submitted() {
        assert_eq!(
            plan_text_input("hi\n"),
            vec![
                KeyStroke::Unicode(u16::from(b'h')),
                KeyStroke::Unicode(u16::from(b'i')),
                KeyStroke::Virtual(VK_RETURN),
            ]
        );
    }

    #[test]
    fn a_tab_becomes_a_tab_keystroke() {
        assert_eq!(plan_text_input("\t"), vec![KeyStroke::Virtual(VK_TAB)]);
    }

    #[test]
    fn a_crlf_pair_is_one_return_not_two() {
        // Text read off disk is CRLF; typing it as two Returns would submit a
        // form twice.
        assert_eq!(
            plan_text_input("a\r\nb"),
            vec![
                KeyStroke::Unicode(u16::from(b'a')),
                KeyStroke::Virtual(VK_RETURN),
                KeyStroke::Unicode(u16::from(b'b')),
            ]
        );
    }

    #[test]
    fn a_lone_carriage_return_is_still_a_return() {
        assert_eq!(
            plan_text_input("a\rb"),
            vec![
                KeyStroke::Unicode(u16::from(b'a')),
                KeyStroke::Virtual(VK_RETURN),
                KeyStroke::Unicode(u16::from(b'b')),
            ]
        );
        assert_eq!(
            plan_text_input("\r\r"),
            vec![KeyStroke::Virtual(VK_RETURN), KeyStroke::Virtual(VK_RETURN),]
        );
    }

    #[test]
    fn non_ascii_text_is_sent_as_code_units() {
        // 'é' fits in one unit; the text must not be mangled into ASCII.
        assert_eq!(plan_text_input("é"), vec![KeyStroke::Unicode(0x00E9)]);
    }

    #[test]
    fn a_character_outside_the_bmp_becomes_a_surrogate_pair() {
        // U+1F600 is two UTF-16 units, and both have to be sent.
        assert_eq!(
            plan_text_input("\u{1F600}"),
            vec![KeyStroke::Unicode(0xD83D), KeyStroke::Unicode(0xDE00)]
        );
    }

    #[test]
    fn an_empty_string_plans_no_keystrokes() {
        assert!(plan_text_input("").is_empty());
    }

    #[test]
    fn the_activation_click_lands_in_the_title_bar() {
        let plan = activation_plan(Rect::new(100, 200, 900, 800));
        assert_eq!(
            plan,
            vec![
                ActivationStep::RaiseTopmost,
                ActivationStep::ClickTitleBar(Point::new(500, 224)),
                ActivationStep::RestoreZOrder,
            ]
        );
    }

    #[test]
    fn a_short_window_still_gets_a_click_inside_it() {
        // 40 pixels tall: the probe depth halves to 19 so the click stays in
        // the window rather than in whatever is behind it.
        let plan = activation_plan(Rect::new(0, 0, 300, 40));
        assert_eq!(
            plan.get(1),
            Some(&ActivationStep::ClickTitleBar(Point::new(150, 19)))
        );

        // 4 pixels tall: down to one pixel below the top edge.
        let plan = activation_plan(Rect::new(10, 10, 210, 14));
        assert_eq!(
            plan.get(1),
            Some(&ActivationStep::ClickTitleBar(Point::new(110, 11)))
        );
    }

    #[test]
    fn the_activation_click_of_a_negative_coordinate_window_stays_inside() {
        let plan = activation_plan(Rect::new(-1920, 0, -960, 1080));
        let Some(ActivationStep::ClickTitleBar(point)) = plan.get(1).copied() else {
            panic!("a click step");
        };
        assert_eq!(point, Point::new(-1440, 24));
        assert!(Rect::new(-1920, 0, -960, 1080).contains(point));
    }

    #[test]
    fn a_window_with_no_clickable_interior_plans_nothing() {
        assert!(activation_plan(Rect::new(10, 10, 10, 60)).is_empty());
        assert!(activation_plan(Rect::new(10, 10, 300, 10)).is_empty());
        assert!(activation_plan(Rect::new(10, 10, 11, 11)).is_empty());
        assert!(activation_plan(Rect::new(300, 300, 0, 0)).is_empty());
    }
}
