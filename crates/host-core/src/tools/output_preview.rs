use super::{Direction, OutputBudget};
use std::path::Path;

pub(super) fn truncate_to(text: &str, budget: OutputBudget, spilled: Option<&Path>) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let hint = match spilled {
        Some(path) => format!(
            " Full output saved to {} — Grep it, or Read it with offset/limit.",
            path.display()
        ),
        None => " Narrow the request to see more.".to_string(),
    };

    // A single line longer than the whole budget (minified bundle, `tr`-style
    // one-shot output) fits no complete line; clip on UTF-8 boundaries while
    // preserving the direction's promise (stderr tail, stdout both ends).
    if lines.len() == 1 && lines[0].len() > budget.max_bytes {
        if budget.direction == Direction::HeadTail {
            let head = clip_head(lines[0], budget.max_bytes / 3);
            let tail = clip_tail(lines[0], budget.max_bytes - head.len());
            let omitted = lines[0].len().saturating_sub(head.len() + tail.len());
            return format!(
                "{head}\n\n[truncated: kept {} head bytes and {} tail bytes of a single {}-byte line; {omitted} bytes omitted within the clipped line.{}]\n\n{tail}",
                head.len(), tail.len(), lines[0].len(), hint
            );
        }
        let clipped = match budget.direction {
            Direction::Tail => clip_tail(lines[0], budget.max_bytes),
            _ => clip_head(lines[0], budget.max_bytes),
        };
        let omitted = lines[0].len().saturating_sub(clipped.len());
        let marker = format!(
            "[truncated: no complete line fits the {limit}KB limit; kept {bytes} bytes of a single {total}-byte line; {omitted} bytes omitted within the clipped line.{hint}]",
            limit = budget.max_bytes / 1024,
            bytes = clipped.len(),
            total = lines[0].len(),
        );
        return match budget.direction {
            Direction::Tail => format!("{marker}\n\n{clipped}"),
            _ => format!("{clipped}\n\n{marker}"),
        };
    }

    let (head, tail) = match budget.direction {
        Direction::Head => (
            keep_head(&lines, budget.max_bytes, budget.max_lines),
            Vec::new(),
        ),
        Direction::Tail => (
            Vec::new(),
            keep_tail(&lines, budget.max_bytes, budget.max_lines),
        ),
        // The opening names the command and the closing names the failure; the
        // middle is the part a follow-up Grep can recover. Two thirds go to the
        // tail because that is where a failing run says why.
        Direction::HeadTail => {
            let head = keep_head(&lines, budget.max_bytes / 3, budget.max_lines / 3);
            let tail = keep_tail(
                &lines[head.len()..],
                budget.max_bytes - budget.max_bytes / 3,
                budget.max_lines.saturating_sub(head.len()),
            );
            (head, tail)
        }
    };

    let kept = head.len() + tail.len();
    let clipped_bytes: usize = head
        .iter()
        .zip(lines.iter())
        .chain(tail.iter().rev().zip(lines.iter().rev()))
        .map(|(part, original)| original.len().saturating_sub(part.len()))
        .sum();
    let omission = if clipped_bytes > 0 {
        format!(
            "{} whole lines omitted; {clipped_bytes} bytes omitted within clipped lines",
            lines.len().saturating_sub(kept)
        )
    } else {
        format!("{} omitted", lines.len().saturating_sub(kept))
    };
    let hint = if clipped_bytes > 0 && budget.direction != Direction::HeadTail {
        format!(" {clipped_bytes} bytes omitted within clipped lines.{hint}")
    } else {
        hint
    };
    let marker = match budget.direction {
        Direction::Head => format!(
            "[truncated: kept the first {} of {} lines; limit {} lines / {}KB.{}]",
            kept,
            lines.len(),
            budget.max_lines,
            budget.max_bytes / 1024,
            hint
        ),
        Direction::Tail => format!(
            "[truncated: kept the last {} of {} lines; limit {} lines / {}KB.{}]",
            kept,
            lines.len(),
            budget.max_lines,
            budget.max_bytes / 1024,
            hint
        ),
        Direction::HeadTail => format!(
            "[truncated: kept the first {} and last {} of {} lines ({}); limit {}KB.{}]",
            head.len(),
            tail.len(),
            lines.len(),
            omission,
            budget.max_bytes / 1024,
            hint
        ),
    };

    let mut parts: Vec<String> = Vec::new();
    if !head.is_empty() {
        parts.push(head.join("\n"));
    }
    parts.push(marker);
    if !tail.is_empty() {
        parts.push(tail.join("\n"));
    }
    parts.join("\n\n")
}

/// Lines from the front that fit `max_bytes` / `max_lines`.
fn keep_head<'a>(lines: &[&'a str], max_bytes: usize, max_lines: usize) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0_usize;
    for line in lines.iter().take(max_lines) {
        let size = line.len() + usize::from(!kept.is_empty());
        if bytes + size > max_bytes {
            let remaining = max_bytes.saturating_sub(bytes + usize::from(!kept.is_empty()));
            let clipped = clip_head(line, remaining);
            if !clipped.is_empty() {
                kept.push(clipped);
            }
            break;
        }
        kept.push(line);
        bytes += size;
    }
    kept
}

/// Lines from the back that fit `max_bytes` / `max_lines`, in file order.
fn keep_tail<'a>(lines: &[&'a str], max_bytes: usize, max_lines: usize) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0_usize;
    for line in lines.iter().rev().take(max_lines) {
        let size = line.len() + usize::from(!kept.is_empty());
        if bytes + size > max_bytes {
            let remaining = max_bytes.saturating_sub(bytes + usize::from(!kept.is_empty()));
            let clipped = clip_tail(line, remaining);
            if !clipped.is_empty() {
                kept.push(clipped);
            }
            break;
        }
        kept.push(line);
        bytes += size;
    }
    kept.reverse();
    kept
}

fn clip_head(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn clip_tail(text: &str, max_bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}
