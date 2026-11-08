//! The Windows uninstaller's engine (FLOWPAD-2250). Called by the NSIS uninstaller
//! (`flow-rs uninstall …`); removes only what FlowPad Desktop provably owns and nothing
//! else uses, and reports exactly what it did.
//!
//! * [`classify`] — what may be removed: pure decisions over gathered facts.
//! * [`procs`] — which running processes may be stopped (verified association only).
//! * [`receipt`] — the parts of uv's tool receipt the decisions read.
//! * [`report`] — the outcome, derived from what was removed, kept and left behind.
//! * [`state`] — the deferred-cleanup state: untrusted, authenticated, never authorization.
//! * [`delete`] — handle-relative, no-follow deletion of an owned tree (Windows only).

pub mod classify;
pub mod procs;
pub mod receipt;
pub mod report;
pub mod state;

#[cfg(windows)]
pub mod delete;
#[cfg(windows)]
mod fsx;
#[cfg(windows)]
pub mod win;
#[cfg(windows)]
pub mod ops;
#[cfg(windows)]
pub mod deferred;
#[cfg(windows)]
pub mod run;

#[cfg(windows)]
pub use fsx::Identity;
