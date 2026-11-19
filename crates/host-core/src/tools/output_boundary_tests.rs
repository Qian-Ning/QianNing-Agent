use super::*;

#[test]
fn head_tail_preview_respects_line_budget_without_duplicates() {
    let text = (0..4500)
        .map(|i| format!("line-{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (out, truncated) = truncate_with_spill(&text, BUDGET_SHELL, None, "test");
    assert!(truncated);
    let kept = out
        .lines()
        .filter(|line| line.starts_with("line-"))
        .collect::<Vec<_>>();
    let unique = kept.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(kept.len(), unique.len(), "preview regions overlap");
    assert!(kept.len() <= BUDGET_SHELL.max_lines, "line budget exceeded");
    assert_eq!(kept.first().copied(), Some("line-0"));
    assert_eq!(kept.last().copied(), Some("line-4499"));
    assert!(out.contains("500 omitted"));
}

#[test]
fn oversized_stderr_line_preserves_the_error_at_its_end() {
    let text = format!("{}FINAL-ERROR", "中".repeat(BUDGET_SHELL_ERR.max_bytes));
    let (out, truncated) = truncate_with_spill(&text, BUDGET_SHELL_ERR, None, "test");
    assert!(truncated);
    assert!(out.starts_with("[truncated:"));
    assert!(out.ends_with("FINAL-ERROR"), "stderr tail was lost");
    assert!(out.len() <= BUDGET_SHELL_ERR.max_bytes + 512);
}

#[test]
fn head_tail_preview_with_byte_overflow_emits_each_line_once() {
    let text = format!("{}\nlast-line", "x".repeat(80));
    let budget = OutputBudget {
        max_bytes: 64,
        max_lines: 4000,
        direction: Direction::HeadTail,
    };
    let (out, truncated) = truncate_with_spill(&text, budget, None, "test");
    assert!(truncated);
    assert_eq!(out.lines().filter(|line| *line == "last-line").count(), 1);
    assert!(out.ends_with("last-line"));
}

#[test]
fn oversized_single_stdout_line_preserves_both_ends() {
    let text = format!("BEGIN{}FINAL-ERROR", "中".repeat(BUDGET_SHELL.max_bytes));
    let (out, truncated) = truncate_with_spill(&text, BUDGET_SHELL, None, "test");
    assert!(truncated);
    assert!(out.starts_with("BEGIN"));
    assert!(out.ends_with("FINAL-ERROR"));
    assert!(out.contains("bytes omitted within the clipped line"));
    assert!(!out.contains("0 bytes omitted"));
    assert!(out.len() <= BUDGET_SHELL.max_bytes + 512);
}

#[test]
fn in_budget_output_is_unchanged_in_every_direction() {
    for direction in [Direction::Head, Direction::Tail, Direction::HeadTail] {
        for text in ["", "one line", "first\nlast\n", "中文\n末尾"] {
            let budget = OutputBudget {
                max_bytes: 1024,
                max_lines: 10,
                direction,
            };
            assert_eq!(
                truncate_with_spill(text, budget, None, "test"),
                (text.to_string(), false)
            );
        }
    }
}

#[test]
fn head_tail_output_keeps_a_single_copy_across_line_limits() {
    for max_lines in 1..10 {
        let text = (0..max_lines + 3)
            .map(|i| format!("line-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let budget = OutputBudget {
            max_bytes: 4096,
            max_lines,
            direction: Direction::HeadTail,
        };
        let (out, _) = truncate_with_spill(&text, budget, None, "test");
        let kept = out
            .lines()
            .filter(|line| line.starts_with("line-"))
            .collect::<Vec<_>>();
        assert!(kept.len() <= max_lines);
        assert_eq!(
            kept.iter().collect::<std::collections::HashSet<_>>().len(),
            kept.len()
        );
    }
}

#[test]
fn multiple_oversized_stderr_lines_still_keep_the_final_error() {
    let text = format!("{}\n{}FINAL-ERROR", "x".repeat(200), "中".repeat(200));
    let budget = OutputBudget {
        max_bytes: 64,
        max_lines: 10,
        direction: Direction::Tail,
    };
    let (out, truncated) = truncate_with_spill(&text, budget, None, "test");
    assert!(truncated);
    assert!(out.ends_with("FINAL-ERROR"));
}

#[test]
fn oversized_stderr_before_short_trailing_lines_keeps_error() {
    for suffix in ["\n\n", "\nshort trailer\n", "\n\nshort trailer\n\n"] {
        let text = format!("{}FINAL-ERROR{suffix}", "中".repeat(96 * 1024));
        let (out, _) = truncate_with_spill(&text, BUDGET_SHELL_ERR, None, "test");
        assert!(
            out.contains("FINAL-ERROR"),
            "error lost before trailer {suffix:?}"
        );
        assert!(out.len() <= BUDGET_SHELL_ERR.max_bytes + 512);
    }
}

#[test]
fn clipped_line_marker_reports_omitted_bytes() {
    let text = format!("{}\nlast-line", "x".repeat(120 * 1024));
    let (out, _) = truncate_with_spill(&text, BUDGET_SHELL, None, "test");
    assert!(out.contains("bytes omitted within clipped lines"));
    assert!(
        !out.contains("(0 omitted)"),
        "must not imply complete preservation"
    );
    assert!(out.ends_with("last-line"));
}

#[test]
fn head_tail_preview_stays_within_byte_and_line_budgets_across_small_bounds() {
    for max_bytes in 0..96 {
        for max_lines in 0..9 {
            let text = (0..15)
                .map(|index| format!("row-{index}-{}", "中".repeat(index % 7 + 1)))
                .collect::<Vec<_>>()
                .join("\n");
            let budget = OutputBudget {
                max_bytes,
                max_lines,
                direction: Direction::HeadTail,
            };
            let (out, _) = truncate_with_spill(&text, budget, None, "test");
            let payload = out
                .lines()
                .filter(|line| line.starts_with("row-"))
                .collect::<Vec<_>>();
            assert!(
                payload.len() <= max_lines,
                "max_lines={max_lines} output={out:?}"
            );
            assert!(
                payload.iter().map(|line| line.len()).sum::<usize>() <= max_bytes,
                "max_bytes={max_bytes} output={out:?}"
            );
            assert_eq!(
                payload
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len(),
                payload.len()
            );
            assert!(out.is_char_boundary(out.len()));
        }
    }
}
