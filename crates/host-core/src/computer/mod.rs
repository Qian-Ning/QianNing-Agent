//! Computer control: virtual-desktop geometry, window enumeration, and input
//! injection.
//!
//! The layer is split in two on purpose. [`geometry`] and [`input`] hold the
//! arithmetic and the event planning — pure, so they are unit-tested on every
//! build host, including CI's Linux runner, which never compiles the Win32
//! half. `windows` performs the platform calls and decides nothing: it
//! executes what the pure half planned.
//!
//! Windows only. On any other host every operation reports
//! [`ComputerError::Unsupported`] instead of doing nothing quietly, because a no-op
//! that reports success would let a caller believe the pointer had moved.
//!
//! Coordinates are virtual-desktop pixels: the origin is the top-left of the
//! bounding box that spans every monitor, so a point is unambiguous on a
//! multi-monitor desktop where the primary monitor may not be at `(0, 0)`.

// The pure half is reached by two callers: the Windows implementation and the
// tests. On any other host only the tests reach it, so the dead-code lint
// would otherwise fire on every helper the Win32 path owns.
#[cfg_attr(not(windows), allow(dead_code))]
mod geometry;
#[cfg_attr(not(windows), allow(dead_code))]
mod input;

pub use geometry::{occluded_fraction, parse_handle, window_at, Point, Rect};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{
    activate_window, click, cursor, list_windows, move_mouse, screen, scroll, type_text,
};

#[cfg(not(windows))]
mod stub;

#[cfg(not(windows))]
pub use stub::{
    activate_window, click, cursor, list_windows, move_mouse, screen, scroll, type_text,
};

/// The virtual desktop in pixels, plus the size a full-desktop capture uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// Bounding box of every monitor, in virtual-desktop pixels.
    pub bounds: Rect,
    /// Width of the primary monitor. A whole-desktop screenshot is usually
    /// scaled from the primary monitor's space, so a caller mapping image
    /// pixels back to coordinates needs this rather than `bounds`.
    pub primary_width: i32,
    /// Height of the primary monitor.
    pub primary_height: i32,
}

/// One top-level window, as `EnumWindows` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    /// Opaque handle as a decimal string. A Windows handle is pointer-sized and
    /// carries no meaning a caller may compute with, and it would lose
    /// precision as a JavaScript number.
    pub handle: String,
    /// Window title, empty when the window has none.
    pub title: String,
    /// Owning process id, so a caller can tell our own windows apart.
    pub process_id: u32,
    /// Window rectangle in virtual-desktop pixels, including the border.
    pub bounds: Rect,
    /// `true` for a minimized window; a minimized window has no drawable area,
    /// so its rectangle is stale and a click inside it would land on whatever
    /// is behind it.
    pub minimized: bool,
}

/// A window plus how much of it the windows in front are covering.
///
/// The pair is what a caller needs to decide where to click: a rectangle says
/// where a window is, but not whether a click inside it would reach it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReport {
    #[serde(flatten)]
    pub window: WindowInfo,
    /// Share of the window covered by the windows in front of it, `0.0` to
    /// `1.0`.
    pub occluded: f64,
}

/// Which mouse button a click uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// Why a computer-control call could not be carried out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerError {
    /// The host platform has no computer-control layer. Only the non-Windows
    /// implementation builds it, so on Windows the variant is defined but
    /// never produced — kept because the RPC layer matches on it and the two
    /// hosts must answer with the same shape.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    /// The window handle no longer names a window, so the call was not made.
    WindowGone(String),
    /// A platform call failed. `code` is the platform's own error value, when
    /// it reported one. Only the Windows implementation builds it, so off
    /// Windows the variant is defined but never produced.
    #[cfg_attr(not(windows), allow(dead_code))]
    Platform {
        operation: &'static str,
        code: Option<u32>,
    },
}

impl std::fmt::Display for ComputerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => {
                write!(formatter, "computer control is only available on Windows")
            }
            Self::WindowGone(handle) => {
                write!(formatter, "window {handle} no longer exists")
            }
            Self::Platform { operation, code } => match code {
                Some(code) => write!(formatter, "{operation} failed (error {code})"),
                None => write!(formatter, "{operation} failed"),
            },
        }
    }
}

impl std::error::Error for ComputerError {}

/// Every visible top-level window, front of the Z-order first, each with the
/// share of itself that the windows in front are covering.
pub fn report_windows() -> Result<Vec<WindowReport>, ComputerError> {
    let windows = list_windows()?;
    Ok(windows
        .iter()
        .enumerate()
        .map(|(index, window)| WindowReport {
            window: window.clone(),
            occluded: occluded_fraction(&windows, index),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_computer_error_says_which_operation_failed() {
        let with_code = ComputerError::Platform {
            operation: "SendInput",
            code: Some(5),
        };
        assert_eq!(with_code.to_string(), "SendInput failed (error 5)");

        let without_code = ComputerError::Platform {
            operation: "SetWindowPos",
            code: None,
        };
        assert_eq!(without_code.to_string(), "SetWindowPos failed");

        assert_eq!(
            ComputerError::Unsupported.to_string(),
            "computer control is only available on Windows"
        );
        assert_eq!(
            ComputerError::WindowGone("42".into()).to_string(),
            "window 42 no longer exists"
        );
    }

    #[test]
    fn a_window_serializes_its_handle_as_a_string() {
        let window = WindowInfo {
            handle: "140234567".into(),
            title: "Untitled".into(),
            process_id: 4242,
            bounds: Rect::new(0, 0, 100, 50),
            minimized: false,
        };
        let value = serde_json::to_value(&window).expect("serializes");
        assert_eq!(value["handle"], serde_json::json!("140234567"));
        assert_eq!(value["processId"], serde_json::json!(4242));
        assert_eq!(value["bounds"]["right"], serde_json::json!(100));
    }

    #[test]
    fn a_window_report_flattens_the_window_into_the_same_object() {
        // A caller reads `handle` and `occluded` side by side; nesting the
        // window under a key would make every consumer drill down one level.
        let report = WindowReport {
            window: WindowInfo {
                handle: "7".into(),
                title: "Editor".into(),
                process_id: 9,
                bounds: Rect::new(0, 0, 10, 10),
                minimized: false,
            },
            occluded: 0.25,
        };
        let value = serde_json::to_value(&report).expect("serializes");
        assert_eq!(value["handle"], serde_json::json!("7"));
        assert_eq!(value["occluded"], serde_json::json!(0.25));
        assert!(value.get("window").is_none());
    }

    #[test]
    fn a_mouse_button_serializes_in_lowercase() {
        assert_eq!(
            serde_json::to_value(MouseButton::Left).expect("serializes"),
            serde_json::json!("left")
        );
        assert_eq!(
            serde_json::to_value(MouseButton::Middle).expect("serializes"),
            serde_json::json!("middle")
        );
    }
}
