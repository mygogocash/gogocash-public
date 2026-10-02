//! One module per instruction (docs/CONTRACT.md 3.3).
//!
//! Each module holds the instruction's `#[derive(Accounts)]` struct and its
//! `handler`. The glob re-exports put the account structs and the client
//! modules Anchor generates for them at the crate root, where `#[program]`
//! expects them. Every module names its handler `handler`, so the globs
//! collide on that one name. The handlers are `pub(crate)`, so the colliding
//! name is never publicly re-exported, and `lib.rs` always calls them by their
//! full path (`instructions::<ix>::handler`), so the ambiguity is never used.

pub mod accept_admin;
pub mod claim;
pub mod initialize;
pub mod pause;
pub mod propose_admin;
pub mod unpause;
pub mod update_config;
pub mod withdraw;

pub use accept_admin::*;
pub use claim::*;
pub use initialize::*;
pub use pause::*;
pub use propose_admin::*;
pub use unpause::*;
pub use update_config::*;
pub use withdraw::*;
