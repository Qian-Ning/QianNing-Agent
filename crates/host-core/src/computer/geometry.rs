//! Pure geometry for the computer-control layer.
//!
//! No platform calls and no I/O, so every rule here is exercised by the unit
//! tests in this file on any build host — including CI's Linux runner, which
//! never compiles the Win32 half.

use serde::{Deserialize, Serialize};

use super::{ComputerError, WindowInfo};

/// A point in virtual-desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

/// A rectangle in virtual-desktop pixels, read as the half-open region
/// `left..right` by `top..bottom`.
///
/// Half-open is what makes the rest of this module simple: two rectangles that
/// share an edge do not overlap, a rectangle's area is exactly
/// `width * height`, and a point is inside `left <= x < right`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    /// Width in pixels; zero for an inverted or empty rectangle.
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(0)
    }

    /// Height in pixels; zero for an inverted or empty rectangle.
    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(0)
    }

    /// Pixel area, widened so a large desktop cannot overflow.
    pub fn area(&self) -> i64 {
        i64::from(self.width()) * i64::from(self.height())
    }

    pub fn is_empty(&self) -> bool {
        self.width() == 0 || self.height() == 0
    }

    pub fn contains(&self, point: Point) -> bool {
        point.x >= self.left && point.x < self.right && point.y >= self.top && point.y < self.bottom
    }

    /// The overlapping region, or `None` when the two do not overlap.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let overlap = Rect::new(
            self.left.max(other.left),
            self.top.max(other.top),
            self.right.min(other.right),
            self.bottom.min(other.bottom),
        );
        if overlap.is_empty() {
            None
        } else {
            Some(overlap)
        }
    }
}

/// The largest value an absolute coordinate may carry.
pub const ABSOLUTE_MAX: i32 = 65_535;

/// Integer division rounded to nearest, for a non-negative dividend.
///
/// A float would work too, but the whole point of this module is arithmetic
/// that cannot drift; `f64` here would make the round-trip test depend on
/// decimal rounding rather than on the mapping.
const fn div_round(value: i64, divisor: i64) -> i64 {
    (value + divisor / 2) / divisor
}

/// Map a virtual-desktop pixel onto the `0..=65535` space `SendInput` expects.
///
/// The divisor is `extent - 1`, so the last pixel of the axis lands exactly on
/// [`ABSOLUTE_MAX`]. Dividing by `extent` is the common mistake and it is
/// visible: on a 1920-wide desktop the rightmost column would arrive one unit
/// and a fraction short, which on a wide desktop is enough to miss a
/// one-pixel target and enough to make the round trip inexact.
///
/// A pixel outside the axis clamps to its nearest end rather than wrapping, so
/// a caller that computed a point from a stale screen size still clicks the
/// edge of the desktop instead of the opposite edge.
pub fn to_absolute(pixel: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    let span = i64::from(extent) - 1;
    let relative = i64::from((pixel - origin).clamp(0, extent - 1));
    div_round(relative * i64::from(ABSOLUTE_MAX), span) as i32
}

/// The inverse of [`to_absolute`]: the pixel an absolute coordinate names.
///
/// Only the tests call this today. It is a real function rather than an inline
/// expression inside the round-trip test because that property is the evidence
/// the forward mapping is right, and a test that re-derived the formula would
/// be checking the formula against itself.
#[cfg(test)]
pub fn from_absolute(absolute: i32, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return origin;
    }
    let span = i64::from(extent) - 1;
    let clamped = i64::from(absolute.clamp(0, ABSOLUTE_MAX));
    origin + div_round(clamped * span, i64::from(ABSOLUTE_MAX)) as i32
}

/// The absolute coordinate pair `SendInput` needs to land on `point`.
pub fn absolute_for(point: Point, screen: Rect) -> (i32, i32) {
    (
        to_absolute(point.x, screen.left, screen.width()),
        to_absolute(point.y, screen.top, screen.height()),
    )
}

/// The frontmost window containing `point`, or `None` when the desktop itself
/// is the topmost thing there.
///
/// `windows` must be in Z-order with the frontmost first — the order
/// `EnumWindows` reports and [`super::list_windows`] preserves. A minimized
/// window is skipped: its rectangle is stale, so picking it would send the
/// click to whatever is *behind* it.
pub fn window_at(windows: &[WindowInfo], point: Point) -> Option<&WindowInfo> {
    windows
        .iter()
        .find(|window| !window.minimized && window.bounds.contains(point))
}

/// How much of the window at `index` is covered by the windows in front of it.
///
/// `index` is the window's position in the Z-order slice, so the only windows
/// that can cover it are the ones before it. The result is exact rather than
/// sampled: x-coordinates are compressed into strips, and inside a strip the
/// covering windows reduce to a union of y-intervals, which is a merge. A
/// sampled estimate would need a resolution choice and would be wrong about
/// the thin slivers that decide whether a click lands.
///
/// Returns `0.0` for an unknown index, an empty window, or a window that is
/// fully in front.
pub fn occluded_fraction(windows: &[WindowInfo], index: usize) -> f64 {
    let Some(target) = windows.get(index).map(|window| window.bounds) else {
        return 0.0;
    };
    let total = target.area();
    if total <= 0 {
        return 0.0;
    }

    let front: Vec<Rect> = windows[..index]
        .iter()
        .filter_map(|window| window.bounds.intersect(&target))
        .collect();
    if front.is_empty() {
        return 0.0;
    }

    let mut edges: Vec<i32> = Vec::with_capacity(front.len() * 2 + 2);
    edges.push(target.left);
    edges.push(target.right);
    for rect in &front {
        edges.push(rect.left);
        edges.push(rect.right);
    }
    edges.sort_unstable();
    edges.dedup();

    let mut covered: i64 = 0;
    for strip in edges.windows(2) {
        let (left, right) = (strip[0], strip[1]);
        let width = i64::from(right - left);
        if width <= 0 {
            continue;
        }
        // A rectangle covers the whole strip or none of it: every rectangle's
        // own edges are in `edges`, so none can start or end inside a strip.
        let mut spans: Vec<(i32, i32)> = front
            .iter()
            .filter(|rect| rect.left <= left && right <= rect.right)
            .map(|rect| (rect.top, rect.bottom))
            .collect();
        if spans.is_empty() {
            continue;
        }
        spans.sort_unstable();
        let mut merged: i64 = 0;
        let (mut start, mut end) = spans[0];
        for &(top, bottom) in &spans[1..] {
            if top > end {
                merged += i64::from(end - start);
                start = top;
                end = bottom;
            } else if bottom > end {
                end = bottom;
            }
        }
        merged += i64::from(end - start);
        covered += width * merged;
    }

    (covered as f64 / total as f64).clamp(0.0, 1.0)
}

/// Parse the decimal handle a caller passes back to us.
pub fn parse_handle(handle: &str) -> Result<u64, ComputerError> {
    handle
        .trim()
        .parse::<u64>()
        .map_err(|_| ComputerError::WindowGone(handle.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(handle: &str, bounds: Rect) -> WindowInfo {
        WindowInfo {
            handle: handle.into(),
            title: handle.into(),
            process_id: 1,
            bounds,
            minimized: false,
        }
    }

    #[test]
    fn a_half_open_rectangle_does_not_contain_its_far_edges() {
        let rect = Rect::new(10, 20, 40, 60);
        assert!(rect.contains(Point::new(10, 20)));
        assert!(rect.contains(Point::new(39, 59)));
        assert!(!rect.contains(Point::new(40, 30)), "right edge is outside");
        assert!(!rect.contains(Point::new(30, 60)), "bottom edge is outside");
        assert!(!rect.contains(Point::new(9, 30)));
    }

    #[test]
    fn rectangles_touching_an_edge_do_not_overlap() {
        let left = Rect::new(0, 0, 100, 100);
        let right = Rect::new(100, 0, 200, 100);
        assert_eq!(left.intersect(&right), None);

        let overlapping = Rect::new(50, 50, 150, 150);
        assert_eq!(
            left.intersect(&overlapping),
            Some(Rect::new(50, 50, 100, 100))
        );
    }

    #[test]
    fn an_inverted_rectangle_has_no_area_and_no_containment() {
        let inverted = Rect::new(100, 100, 0, 0);
        assert_eq!(inverted.width(), 0);
        assert_eq!(inverted.height(), 0);
        assert_eq!(inverted.area(), 0);
        assert!(inverted.is_empty());
        assert!(!inverted.contains(Point::new(50, 50)));
        assert_eq!(inverted.intersect(&Rect::new(0, 0, 200, 200)), None);
    }

    #[test]
    fn a_large_virtual_desktop_area_does_not_overflow() {
        // 8K wide by 8K tall is 64 million pixels, far past i32 for a whole
        // virtual desktop of several such monitors.
        let huge = Rect::new(-100_000, -100_000, 100_000, 100_000);
        assert_eq!(huge.area(), 40_000_000_000);
    }

    #[test]
    fn absolute_coordinates_reach_both_ends_exactly() {
        assert_eq!(to_absolute(0, 0, 1920), 0);
        assert_eq!(to_absolute(1919, 0, 1920), ABSOLUTE_MAX);
        assert_eq!(to_absolute(-500, 0, 1920), 0, "left of the axis clamps");
        assert_eq!(to_absolute(5_000, 0, 1920), ABSOLUTE_MAX);
    }

    #[test]
    fn absolute_coordinates_respect_a_negative_origin() {
        // A monitor arranged to the left of the primary one gives the virtual
        // desktop a negative left edge; that must not shift the mapping.
        let screen = Rect::new(-1920, 0, 3840, 1080);
        assert_eq!(screen.width(), 5760);
        assert_eq!(to_absolute(-1920, screen.left, screen.width()), 0);
        assert_eq!(to_absolute(3839, screen.left, screen.width()), ABSOLUTE_MAX);
    }

    #[test]
    fn absolute_coordinates_are_monotonic() {
        let mut previous = -1;
        for pixel in (0..1920).step_by(7) {
            let absolute = to_absolute(pixel, 0, 1920);
            assert!(absolute >= previous, "not monotonic at {pixel}");
            assert!((0..=ABSOLUTE_MAX).contains(&absolute));
            previous = absolute;
        }
    }

    #[test]
    fn every_pixel_round_trips_through_the_absolute_space() {
        // The point of dividing by `extent - 1`: a coordinate that survives a
        // trip to SendInput and back must name the same pixel, or a caller
        // verifying its own click would chase a one-pixel error forever.
        for extent in [1920, 2560, 3440, 3840, 5760, 7680, 11519] {
            for pixel in [0, 1, 2, extent / 3, extent / 2, extent - 2, extent - 1] {
                let absolute = to_absolute(pixel, 0, extent);
                assert_eq!(
                    from_absolute(absolute, 0, extent),
                    pixel,
                    "extent {extent} pixel {pixel} -> {absolute}"
                );
            }
        }
    }

    #[test]
    fn a_negative_origin_also_round_trips() {
        for pixel in [-1920, -1000, -1, 0, 1, 1919, 3839] {
            let absolute = to_absolute(pixel, -1920, 5760);
            assert_eq!(from_absolute(absolute, -1920, 5760), pixel);
        }
    }

    #[test]
    fn a_degenerate_axis_maps_to_the_origin() {
        assert_eq!(to_absolute(500, 7, 1), 0);
        assert_eq!(to_absolute(500, 7, 0), 0);
        assert_eq!(from_absolute(30_000, 7, 1), 7);
        assert_eq!(from_absolute(30_000, 7, 0), 7);
    }

    #[test]
    fn absolute_for_uses_each_axis_extent_independently() {
        let screen = Rect::new(0, 0, 1600, 900);
        // Division is by `extent - 1`, not by `extent`: 800 * 65535 / 1599.
        assert_eq!(absolute_for(Point::new(800, 450), screen), (32_788, 32_804));
        assert_eq!(
            absolute_for(Point::new(1599, 899), screen),
            (65_535, 65_535)
        );
        assert_eq!(absolute_for(Point::new(0, 0), screen), (0, 0));
    }

    #[test]
    fn the_frontmost_window_under_a_point_wins() {
        let windows = vec![
            window("top", Rect::new(0, 0, 400, 400)),
            window("middle", Rect::new(100, 100, 500, 500)),
            window("bottom", Rect::new(200, 200, 600, 600)),
        ];
        // Inside all three: the first in Z-order answers.
        let hit = window_at(&windows, Point::new(250, 250)).expect("a window");
        assert_eq!(hit.handle, "top");
        // Inside the last two only.
        let hit = window_at(&windows, Point::new(450, 450)).expect("a window");
        assert_eq!(hit.handle, "middle");
        // Inside the last one only.
        let hit = window_at(&windows, Point::new(550, 550)).expect("a window");
        assert_eq!(hit.handle, "bottom");
        // Bare desktop.
        assert!(window_at(&windows, Point::new(700, 700)).is_none());
    }

    #[test]
    fn a_minimized_window_is_not_the_target() {
        // Its rectangle is stale, so answering with it would aim the click at
        // whatever is actually drawn there.
        let mut minimized = window("minimized", Rect::new(0, 0, 400, 400));
        minimized.minimized = true;
        let windows = vec![minimized, window("real", Rect::new(0, 0, 400, 400))];

        let hit = window_at(&windows, Point::new(10, 10)).expect("a window");
        assert_eq!(hit.handle, "real");
    }

    #[test]
    fn the_top_window_of_a_stack_is_never_occluded() {
        let windows = vec![
            window("a", Rect::new(0, 0, 100, 100)),
            window("b", Rect::new(0, 0, 100, 100)),
        ];
        assert_eq!(occluded_fraction(&windows, 0), 0.0);
    }

    #[test]
    fn a_fully_covered_window_reports_full_occlusion() {
        let windows = vec![
            window("cover", Rect::new(0, 0, 200, 200)),
            window("under", Rect::new(50, 50, 150, 150)),
        ];
        assert_eq!(occluded_fraction(&windows, 1), 1.0);
    }

    #[test]
    fn partial_overlap_is_measured_exactly() {
        // The lower window is 100x100; the one in front covers its left half.
        let windows = vec![
            window("cover", Rect::new(0, 0, 50, 200)),
            window("under", Rect::new(0, 0, 100, 100)),
        ];
        assert_eq!(occluded_fraction(&windows, 1), 0.5);
    }

    #[test]
    fn overlapping_covers_are_not_double_counted() {
        // Two covers overlap each other over the same quarter of the target,
        // so a naive sum of intersections would report 3/4 instead of 1/2.
        let windows = vec![
            window("one", Rect::new(0, 0, 50, 100)),
            window("two", Rect::new(0, 0, 50, 100)),
            window("under", Rect::new(0, 0, 100, 100)),
        ];
        assert_eq!(occluded_fraction(&windows, 2), 0.5);
    }

    #[test]
    fn occlusion_counts_only_the_overlapping_part_of_a_cover() {
        // The cover extends well past the target; only the overlap counts.
        let windows = vec![
            window("cover", Rect::new(-1000, -1000, 1000, 10)),
            window("under", Rect::new(0, 0, 100, 100)),
        ];
        assert_eq!(occluded_fraction(&windows, 1), 0.1);
    }

    #[test]
    fn occlusion_is_zero_for_an_unknown_window_or_an_empty_one() {
        let windows = vec![
            window("cover", Rect::new(0, 0, 100, 100)),
            window("flat", Rect::new(10, 10, 10, 60)),
        ];
        assert_eq!(occluded_fraction(&windows, 9), 0.0);
        assert_eq!(occluded_fraction(&windows, 1), 0.0, "zero area is not 100%");
    }

    #[test]
    fn occlusion_handles_a_window_split_into_two_strips() {
        // An L of covers leaves the top-right corner free: the union is not a
        // rectangle, which is exactly the case a single intersection misses.
        let windows = vec![
            window("left", Rect::new(0, 0, 40, 100)),
            window("bottom", Rect::new(40, 60, 100, 100)),
            window("under", Rect::new(0, 0, 100, 100)),
        ];
        // 40x100 + 60x40 of 100x100 covered.
        assert_eq!(occluded_fraction(&windows, 2), 0.64);
    }

    #[test]
    fn a_handle_must_be_a_decimal_number() {
        assert_eq!(parse_handle("140234567").expect("parses"), 140_234_567);
        assert_eq!(parse_handle("  42 ").expect("trims"), 42);
        for bad in ["", "0x1f", "140234567abc", "-1", "1.5"] {
            assert!(
                matches!(parse_handle(bad), Err(ComputerError::WindowGone(_))),
                "accepted {bad}"
            );
        }
    }
}
