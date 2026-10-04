//! The non-Windows half of the computer-control layer.
//!
//! Every operation reports [`ComputerError::Unsupported`]. Reporting an error
//! rather than succeeding quietly is the point: a caller that reads success
//! from a no-op would believe the pointer had moved and go on to act on that
//! belief.

use super::{ComputerError, MouseButton, Point, Screen, WindowInfo};

const UNSUPPORTED: ComputerError = ComputerError::Unsupported;

pub fn screen() -> Result<Screen, ComputerError> {
    Err(UNSUPPORTED)
}

pub fn cursor() -> Result<Point, ComputerError> {
    Err(UNSUPPORTED)
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ComputerError> {
    Err(UNSUPPORTED)
}

pub fn move_mouse(_point: Point) -> Result<(), ComputerError> {
    Err(UNSUPPORTED)
}

pub fn click(_point: Point, _button: MouseButton, _count: u8) -> Result<(), ComputerError> {
    Err(UNSUPPORTED)
}

pub fn scroll(_point: Point, _horizontal: i32, _vertical: i32) -> Result<(), ComputerError> {
    Err(UNSUPPORTED)
}

pub fn type_text(_text: &str) -> Result<(), ComputerError> {
    Err(UNSUPPORTED)
}

pub fn activate_window(_handle: &str) -> Result<(), ComputerError> {
    Err(UNSUPPORTED)
}
