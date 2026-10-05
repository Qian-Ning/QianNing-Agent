//! Parameter parsing shared by the RPC methods and the agent tool.
//!
//! Both surfaces accept the same arguments and must reject the same shapes, so
//! the rules live here once: a fractional coordinate, an out-of-range pixel, an
//! unknown button, an over-long text, or a malformed window handle is refused
//! identically whichever door the request came through.
//!
//! Every function returns `Err(message)` rather than a typed error because the
//! two callers report failures differently — the RPC layer as a JSON-RPC error
//! object, the tool layer as a tool result — and neither shape belongs here.

use serde_json::Value;

use super::{MouseButton, Point};

/// The largest text a single `typeText` may type, in characters.
///
/// A round of automation types a field, not a document, and a bound keeps one
/// call from building a keystroke array of unbounded size.
pub const MAX_TEXT_CHARS: usize = 4096;

/// The most clicks one `click` may send. Three covers a double-click and the
/// triple-click that selects a line.
pub const MAX_CLICK_COUNT: i64 = 3;

/// The most wheel notches one `scroll` may send per axis.
pub const MAX_SCROLL_NOTCHES: i64 = 20;

/// Every coordinate is a whole number of pixels. A float is rejected rather
/// than truncated: a caller that computed `1920.5` has a bug, and silently
/// dropping the fraction would hide it behind a click that nearly landed.
pub fn coordinate(params: &Value, key: &str) -> Result<i32, String> {
    let raw = params
        .get(key)
        .ok_or_else(|| format!("{key} is required"))?;
    let value = raw
        .as_i64()
        .ok_or_else(|| format!("{key} must be an integer"))?;
    i32::try_from(value).map_err(|_| format!("{key} is out of range"))
}

pub fn point(params: &Value) -> Result<Point, String> {
    Ok(Point::new(
        coordinate(params, "x")?,
        coordinate(params, "y")?,
    ))
}

pub fn button(params: &Value) -> Result<MouseButton, String> {
    match params.get("button") {
        None | Some(Value::Null) => Ok(MouseButton::Left),
        Some(Value::String(name)) => match name.as_str() {
            "left" => Ok(MouseButton::Left),
            "right" => Ok(MouseButton::Right),
            "middle" => Ok(MouseButton::Middle),
            other => Err(format!("button must be left, right or middle, not {other}")),
        },
        Some(_) => Err("button must be a string".into()),
    }
}

pub fn click_count(params: &Value) -> Result<u8, String> {
    match params.get("count") {
        None | Some(Value::Null) => Ok(1),
        Some(raw) => {
            let count = raw
                .as_i64()
                .ok_or_else(|| "count must be an integer".to_string())?;
            if !(1..=MAX_CLICK_COUNT).contains(&count) {
                return Err(format!("count must be between 1 and {MAX_CLICK_COUNT}"));
            }
            Ok(count as u8)
        }
    }
}

/// Wheel notches on one axis; positive is right or up, as the caller sees it.
///
/// Out of range is an error rather than a clamp: a scroll of a thousand
/// notches is a caller that lost track of its own state, and clamping would
/// look like it worked.
pub fn notches(params: &Value, key: &str) -> Result<i32, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(raw) => {
            let notches = raw
                .as_i64()
                .ok_or_else(|| format!("{key} must be an integer"))?;
            if notches.abs() > MAX_SCROLL_NOTCHES {
                return Err(format!(
                    "{key} must be between -{MAX_SCROLL_NOTCHES} and {MAX_SCROLL_NOTCHES}"
                ));
            }
            Ok(notches as i32)
        }
    }
}

pub fn text(params: &Value) -> Result<String, String> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "text must be a string".to_string())?;
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("text must be at most {MAX_TEXT_CHARS} characters"));
    }
    Ok(text.to_string())
}

/// A window handle, validated before any platform call so a malformed one is
/// reported the same way on every host rather than only where the platform
/// layer runs.
pub fn handle(params: &Value) -> Result<String, String> {
    let handle = params
        .get("handle")
        .and_then(Value::as_str)
        .ok_or_else(|| "handle must be a string".to_string())?;
    super::parse_handle(handle).map_err(|_| "handle must be a decimal number".to_string())?;
    Ok(handle.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_coordinate_must_be_a_whole_number() {
        assert!(coordinate(&json!({ "x": 1.5 }), "x").is_err());
        assert!(coordinate(&json!({ "x": "10" }), "x").is_err());
        assert!(coordinate(&json!({}), "x").is_err());
        assert!(coordinate(&json!({ "x": -3_000_000_000i64 }), "x").is_err());
        assert_eq!(coordinate(&json!({ "x": -1920 }), "x").unwrap(), -1920);
    }

    #[test]
    fn a_point_needs_both_axes() {
        assert!(point(&json!({ "x": 10 })).is_err());
        assert!(point(&json!({ "y": 10 })).is_err());
        assert_eq!(
            point(&json!({ "x": 10, "y": 20 })).unwrap(),
            Point::new(10, 20)
        );
    }

    #[test]
    fn a_button_defaults_to_the_left_one() {
        assert_eq!(button(&json!({})).unwrap(), MouseButton::Left);
        assert_eq!(
            button(&json!({ "button": null })).unwrap(),
            MouseButton::Left
        );
        assert_eq!(
            button(&json!({ "button": "right" })).unwrap(),
            MouseButton::Right
        );
        assert!(button(&json!({ "button": "back" })).is_err());
        assert!(button(&json!({ "button": 1 })).is_err());
    }

    #[test]
    fn a_click_count_defaults_to_one_and_is_bounded() {
        assert_eq!(click_count(&json!({})).unwrap(), 1);
        for bad in [0i64, -1, 4, 1000] {
            assert!(
                click_count(&json!({ "count": bad })).is_err(),
                "count {bad}"
            );
        }
        assert!(click_count(&json!({ "count": 1.5 })).is_err());
        assert_eq!(click_count(&json!({ "count": 3 })).unwrap(), 3);
    }

    #[test]
    fn a_scroll_axis_defaults_to_zero_and_is_bounded() {
        assert_eq!(notches(&json!({}), "vertical").unwrap(), 0);
        assert_eq!(
            notches(&json!({ "vertical": -20 }), "vertical").unwrap(),
            -20
        );
        assert!(notches(&json!({ "vertical": 21 }), "vertical").is_err());
        assert!(notches(&json!({ "vertical": "up" }), "vertical").is_err());
    }

    #[test]
    fn the_text_bound_counts_characters_rather_than_bytes() {
        let multi_byte = "é".repeat(MAX_TEXT_CHARS);
        assert!(
            multi_byte.len() > MAX_TEXT_CHARS,
            "the case only means something if the byte length exceeds the bound"
        );
        assert!(text(&json!({ "text": multi_byte })).is_ok());

        let over = "é".repeat(MAX_TEXT_CHARS + 1);
        assert!(text(&json!({ "text": over })).is_err());

        assert!(text(&json!({})).is_err());
        assert!(text(&json!({ "text": 5 })).is_err());
    }

    #[test]
    fn a_window_handle_must_be_a_decimal_number() {
        for bad in ["", "0x1f", "-1", "twelve", "1.5"] {
            assert!(handle(&json!({ "handle": bad })).is_err(), "handle {bad}");
        }
        assert!(handle(&json!({ "handle": 42 })).is_err());
        assert!(handle(&json!({})).is_err());
        assert_eq!(
            handle(&json!({ "handle": "140234567" })).unwrap(),
            "140234567"
        );
    }
}
