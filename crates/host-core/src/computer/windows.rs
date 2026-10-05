//! The Win32 half of the computer-control layer.
//!
//! This module decides nothing: it executes what [`super::geometry`] and
//! [`super::input`] planned, and turns a failed platform call into a
//! [`ComputerError`] rather than retrying or guessing.
//!
//! Two platform facts shape the code:
//!
//! * Mouse motion is sent as *absolute* coordinates with
//!   `MOUSEEVENTF_VIRTUALDESK`. Relative motion is scaled by whatever pointer
//!   acceleration the user has configured, so a relative move of N pixels does
//!   not land N pixels away and the error compounds across a click.
//! * `SetForegroundWindow` cannot be used. Windows refuses it unless the
//!   calling process already owns the foreground, and the documented
//!   workarounds are all unsupported. What does work is the sequence in
//!   [`super::input::activation_plan`]: raise the window out of band, click its title
//!   bar — a real input event, which is the one thing Windows accepts as
//!   permission to change the foreground — then drop it back.

use std::thread;
use std::time::Duration;

use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, POINT, RECT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetCursorPos, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetWindowPos,
    HWND_NOTOPMOST, HWND_TOPMOST, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    WHEEL_DELTA,
};

use super::geometry::{absolute_for, parse_handle};
use super::input::{activation_plan, plan_text_input, ActivationStep, KeyStroke};
use super::{ComputerError, MouseButton, Point, Rect, Screen, WindowInfo};

/// How many input events go into one `SendInput` call.
///
/// `SendInput` has no documented ceiling, but a long string would otherwise
/// build one enormous array; chunking also means a partial failure names a
/// smaller unit of work.
const INPUT_BATCH: usize = 64;

/// How long the raised window is given to settle before the title-bar click.
const RAISE_SETTLE: Duration = Duration::from_millis(60);

fn mouse_input(dx: i32, dy: i32, data: u32, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(virtual_key: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: virtual_key,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Inject every event, in order, and fail loudly if Windows drops any of them.
fn send(events: &[INPUT]) -> Result<(), ComputerError> {
    for batch in events.chunks(INPUT_BATCH) {
        // Safety: `batch` is a live slice of fully initialised `INPUT` values
        // and the count matches, which is all `SendInput` reads.
        let sent = unsafe {
            SendInput(
                batch.len() as u32,
                batch.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent as usize != batch.len() {
            // A short count means the input desktop refused the events, which
            // happens when the session is locked or a higher-integrity window
            // holds the foreground. Reporting the code lets the caller tell
            // those apart instead of retrying forever.
            return Err(ComputerError::Platform {
                operation: "SendInput",
                code: Some(unsafe { GetLastError() }),
            });
        }
    }
    Ok(())
}

/// The absolute mouse events that put the pointer on `point` in `screen`.
fn move_events(point: Point, screen: Rect) -> INPUT {
    let (dx, dy) = absolute_for(point, screen);
    mouse_input(
        dx,
        dy,
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    )
}

pub fn screen() -> Result<Screen, ComputerError> {
    // Safety: `GetSystemMetrics` reads no caller memory.
    let (left, top, width, height, primary_width, primary_height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
            GetSystemMetrics(SM_CXSCREEN),
            GetSystemMetrics(SM_CYSCREEN),
        )
    };
    if width <= 0 || height <= 0 {
        // A session with no attached display reports an empty virtual screen;
        // coordinates derived from it would all clamp to the origin.
        return Err(ComputerError::Platform {
            operation: "GetSystemMetrics",
            code: None,
        });
    }
    Ok(Screen {
        bounds: Rect::new(left, top, left + width, top + height),
        primary_width,
        primary_height,
    })
}

pub fn cursor() -> Result<Point, ComputerError> {
    let mut point = POINT { x: 0, y: 0 };
    // Safety: `point` is a live, writable `POINT`.
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        return Err(ComputerError::Platform {
            operation: "GetCursorPos",
            code: Some(unsafe { GetLastError() }),
        });
    }
    Ok(Point::new(point.x, point.y))
}

unsafe extern "system" fn collect_handle(hwnd: HWND, lparam: LPARAM) -> i32 {
    let collected = lparam as *mut Vec<HWND>;
    if !collected.is_null() {
        // Safety: the only caller passes a pointer to a `Vec<HWND>` that
        // outlives the enumeration.
        (*collected).push(hwnd);
    }
    1
}

fn window_title(hwnd: HWND) -> String {
    // Safety: `hwnd` was returned by `EnumWindows` moments ago. A window can
    // disappear between the two calls, which simply yields a zero length.
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; length as usize + 1];
    // Safety: the buffer holds `length + 1` writable units and the capacity
    // matches the length passed, which is what `GetWindowTextW` requires.
    let written = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if written <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..written as usize])
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ComputerError> {
    let mut handles: Vec<HWND> = Vec::new();
    // Safety: the callback only appends to the vector named by `lparam`, and
    // `EnumWindows` runs it on this thread before returning.
    let ok = unsafe {
        EnumWindows(
            Some(collect_handle),
            &mut handles as *mut Vec<HWND> as LPARAM,
        )
    };
    if ok == 0 {
        return Err(ComputerError::Platform {
            operation: "EnumWindows",
            code: Some(unsafe { GetLastError() }),
        });
    }

    // `EnumWindows` yields handles in Z-order, frontmost first, and the
    // callers of `window_at` rely on that order being preserved here.
    let mut windows = Vec::with_capacity(handles.len());
    for hwnd in handles {
        // Safety: each call takes an HWND Windows just handed us and reads
        // only that window's state. A hidden window is dropped here rather
        // than reported: it is enumerable but not clickable, and a caller
        // that aimed at it would hit whatever is in front.
        if unsafe { IsWindowVisible(hwnd) } == 0 {
            continue;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // Safety: `rect` is live and writable.
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            // The window went away mid-enumeration; skipping it is correct,
            // and it must not be reported with a stale rectangle.
            continue;
        }
        let minimized = unsafe { IsIconic(hwnd) } != 0;
        let mut process_id: u32 = 0;
        // Safety: `process_id` is live and writable.
        unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
        windows.push(WindowInfo {
            handle: (hwnd as usize).to_string(),
            title: window_title(hwnd),
            process_id,
            bounds: Rect::new(rect.left, rect.top, rect.right, rect.bottom),
            minimized,
        });
    }
    Ok(windows)
}

pub fn move_mouse(point: Point) -> Result<(), ComputerError> {
    let screen = screen()?.bounds;
    send(&[move_events(point, screen)])
}

pub fn click(point: Point, button: MouseButton, count: u8) -> Result<(), ComputerError> {
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    let screen = screen()?.bounds;
    let mut events = vec![move_events(point, screen)];
    // The presses go into one batch so the second click of a double-click
    // arrives inside the double-click interval; sending them separately would
    // let the gap grow past it on a loaded machine.
    for _ in 0..count.max(1) {
        events.push(mouse_input(0, 0, 0, down));
        events.push(mouse_input(0, 0, 0, up));
    }
    send(&events)
}

pub fn scroll(point: Point, horizontal: i32, vertical: i32) -> Result<(), ComputerError> {
    if horizontal == 0 && vertical == 0 {
        return Ok(());
    }
    let screen = screen()?.bounds;
    let mut events = vec![move_events(point, screen)];
    if vertical != 0 {
        events.push(mouse_input(
            0,
            0,
            (vertical * WHEEL_DELTA as i32) as u32,
            MOUSEEVENTF_WHEEL,
        ));
    }
    if horizontal != 0 {
        events.push(mouse_input(
            0,
            0,
            (horizontal * WHEEL_DELTA as i32) as u32,
            MOUSEEVENTF_HWHEEL,
        ));
    }
    send(&events)
}

pub fn type_text(text: &str) -> Result<(), ComputerError> {
    let plan = plan_text_input(text);
    if plan.is_empty() {
        return Ok(());
    }
    let mut events = Vec::with_capacity(plan.len() * 2);
    for stroke in plan {
        match stroke {
            // A virtual key carries the key code in `wVk` and no scan code.
            KeyStroke::Virtual(code) => {
                events.push(key_input(code, 0, 0));
                events.push(key_input(code, 0, KEYEVENTF_KEYUP));
            }
            // A unicode stroke is the opposite: `KEYEVENTF_UNICODE` reads the
            // character from `wScan` and ignores `wVk`.
            KeyStroke::Unicode(unit) => {
                events.push(key_input(0, unit, KEYEVENTF_UNICODE));
                events.push(key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
    }
    send(&events)
}

pub fn activate_window(handle: &str) -> Result<(), ComputerError> {
    let hwnd = parse_handle(handle)? as usize as HWND;
    // Safety: an HWND that is no longer valid is exactly what this asks about;
    // every other call below is guarded by the answer.
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(ComputerError::WindowGone(handle.to_string()));
    }
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // Safety: `rect` is live and writable.
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err(ComputerError::WindowGone(handle.to_string()));
    }
    let bounds = Rect::new(rect.left, rect.top, rect.right, rect.bottom);
    let plan = activation_plan(bounds);
    if plan.is_empty() {
        return Err(ComputerError::Platform {
            operation: "activation without a clickable title bar",
            code: None,
        });
    }

    for step in plan {
        match step {
            ActivationStep::RaiseTopmost => {
                set_z_order(hwnd, HWND_TOPMOST)?;
                thread::sleep(RAISE_SETTLE);
            }
            ActivationStep::ClickTitleBar(point) => click(point, MouseButton::Left, 1)?,
            ActivationStep::RestoreZOrder => set_z_order(hwnd, HWND_NOTOPMOST)?,
        }
    }
    Ok(())
}

fn set_z_order(hwnd: HWND, insert_after: HWND) -> Result<(), ComputerError> {
    // SWP_NOACTIVATE matters: the activation has to come from the title-bar
    // click, and asking the z-order change to activate as well would be the
    // very request Windows refuses.
    let ok = unsafe {
        SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    };
    if ok == 0 {
        return Err(ComputerError::Platform {
            operation: "SetWindowPos",
            code: Some(unsafe { GetLastError() }),
        });
    }
    Ok(())
}
