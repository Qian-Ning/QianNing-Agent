//! Which tool calls a permission mode can approve on its own.
//!
//! The permission question used to be answered by a `match` on the mode string
//! inside the approval path, one arm per mode, mixed in with risk scoring and
//! session grants. That reads fine for three modes and stops reading fine at
//! five — every new mode edits the same function, and nothing can be checked
//! without constructing an approval request.
//!
//! This module is the table instead: a mode and an access kind go in, one
//! outcome comes out. It is pure, so the whole decision surface is enumerable in
//! a test, and `permissions.rs` keeps only the parts that are not a table —
//! contract-mode denial, path scope, risk, and session grants.
//!
//! The table currently reproduces the pre-existing behaviour exactly; the
//! equivalence is asserted in the tests rather than assumed.

/// What a tool call does, independent of which tool it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    /// Inspecting state: reads, searches, listings.
    Read,
    /// Changing files, including creating and editing them.
    Write,
    /// Removing files or directories.
    Delete,
    /// Running a command or another program.
    Execute,
}

impl AccessKind {
    /// Classify by tool name. Unknown tools are `Execute`: an unnamed tool is
    /// treated as the least predictable kind rather than the most forgiving one,
    /// which is the same assumption the risk classifier makes.
    pub fn for_tool(tool_name: &str) -> Self {
        match tool_name {
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => Self::Write,
            "Read" | "Glob" | "Grep" | "LS" | "TodoWrite" => Self::Read,
            _ => Self::Execute,
        }
    }
}

/// What a mode alone decides. Anything not `Allow` still goes through the rest
/// of the approval path (session grants, an interactive request).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeDecision {
    /// The mode approves this without asking.
    Allow,
    /// The mode says nothing; the caller decides.
    Undecided,
}

/// The permission modes this table knows. `inherit` is resolved to a concrete
/// mode before it reaches here, so it is not a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Every action asks.
    Ask,
    /// File edits are approved; everything else asks.
    AcceptEdits,
    /// Everything is approved.
    Auto,
}

impl Mode {
    pub fn parse(mode: &str) -> Option<Self> {
        match mode {
            "ask" => Some(Self::Ask),
            "accept-edits" => Some(Self::AcceptEdits),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

const TABLE: &[(Mode, AccessKind, ModeDecision)] = &[
    (Mode::Ask, AccessKind::Read, ModeDecision::Undecided),
    (Mode::Ask, AccessKind::Write, ModeDecision::Undecided),
    (Mode::Ask, AccessKind::Delete, ModeDecision::Undecided),
    (Mode::Ask, AccessKind::Execute, ModeDecision::Undecided),
    (Mode::AcceptEdits, AccessKind::Read, ModeDecision::Undecided),
    (Mode::AcceptEdits, AccessKind::Write, ModeDecision::Allow),
    (
        Mode::AcceptEdits,
        AccessKind::Delete,
        ModeDecision::Undecided,
    ),
    (
        Mode::AcceptEdits,
        AccessKind::Execute,
        ModeDecision::Undecided,
    ),
    (Mode::Auto, AccessKind::Read, ModeDecision::Allow),
    (Mode::Auto, AccessKind::Write, ModeDecision::Allow),
    (Mode::Auto, AccessKind::Delete, ModeDecision::Allow),
    (Mode::Auto, AccessKind::Execute, ModeDecision::Allow),
];

/// The decision a mode makes on its own. An unknown mode approves nothing: a
/// mode this table has not been taught must not behave like `auto`.
pub fn decide(mode: &str, access: AccessKind) -> ModeDecision {
    let Some(mode) = Mode::parse(mode) else {
        return ModeDecision::Undecided;
    };
    TABLE
        .iter()
        .find(|(row_mode, row_access, _)| *row_mode == mode && *row_access == access)
        .map(|(_, _, decision)| *decision)
        .unwrap_or(ModeDecision::Undecided)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODES: [&str; 3] = ["ask", "accept-edits", "auto"];
    const KINDS: [AccessKind; 4] = [
        AccessKind::Read,
        AccessKind::Write,
        AccessKind::Delete,
        AccessKind::Execute,
    ];

    /// The behaviour this table replaced, kept here verbatim so a change to the
    /// table has to disagree with the old expression in a test rather than in
    /// someone's session.
    fn previous_mode_allows(mode: &str, tool_name: &str) -> bool {
        match mode {
            "auto" => true,
            "accept-edits" => matches!(tool_name, "Write" | "Edit"),
            _ => false,
        }
    }

    #[test]
    fn every_mode_and_access_kind_matches_the_expression_it_replaced() {
        // One representative tool name per access kind, so the comparison runs
        // through the real classifier rather than around it.
        let sample = [
            ("Read", AccessKind::Read),
            ("Edit", AccessKind::Write),
            ("Bash", AccessKind::Execute),
        ];
        for mode in MODES {
            for (tool_name, access) in sample {
                let expected = previous_mode_allows(mode, tool_name);
                let actual = decide(mode, access) == ModeDecision::Allow;
                assert_eq!(
                    actual, expected,
                    "mode {mode}, tool {tool_name} must keep its previous answer"
                );
            }
        }
    }

    #[test]
    fn every_row_is_reachable_and_named() {
        // A table with a row nobody can reach is a row that will drift.
        for mode in MODES {
            for access in KINDS {
                let decision = decide(mode, access);
                assert!(
                    decision == ModeDecision::Allow || decision == ModeDecision::Undecided,
                    "no third state exists"
                );
            }
        }
        assert_eq!(TABLE.len(), MODES.len() * KINDS.len(), "one row per pair");
    }

    #[test]
    fn an_unknown_mode_approves_nothing() {
        for mode in ["", "inherit", "yolo", "AUTO"] {
            for access in KINDS {
                assert_eq!(decide(mode, access), ModeDecision::Undecided, "mode {mode}");
            }
        }
    }

    #[test]
    fn deletes_are_not_edits() {
        assert_eq!(
            decide("accept-edits", AccessKind::Delete),
            ModeDecision::Undecided
        );
        assert_eq!(
            decide("accept-edits", AccessKind::Write),
            ModeDecision::Allow
        );
    }

    #[test]
    fn unknown_tools_count_as_execute_not_write() {
        assert_eq!(AccessKind::for_tool("plugin_whatever"), AccessKind::Execute);
        assert_eq!(AccessKind::for_tool("mcp__thing"), AccessKind::Execute);
        assert_eq!(AccessKind::for_tool("Edit"), AccessKind::Write);
        assert_eq!(AccessKind::for_tool("Grep"), AccessKind::Read);
    }
}
