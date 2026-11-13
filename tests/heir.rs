//! Heir binding: a note's sweep destination is fixed before it holds bitcoin, and no holder
//! can sweep it anywhere else.

mod common;

use common::*;
use serde_json::json;

const THIEF: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

fn assert_reverts(r: &near_workspaces::result::ExecutionFinalResult, needle: &str) {
    assert!(r.is_failure(), "expected a revert containing {needle:?}");
    let t = fail_text(r);
    assert!(t.contains(needle), "revert text {t:?} lacks {needle:?}");
}

async fn bind(w: &World, who: &near_workspaces::Account, id: &str, dest: &str) -> near_workspaces::result::ExecutionFinalResult {
    who.call(w.cachet.id(), "bind_heir").args_json(json!({"token_id": id, "btc_dest": dest})).max_gas().transact().await.unwrap()
}

#[tokio::test]
async fn a_bound_note_sweeps_only_to_its_heir_whoever_holds_it() {
    let w = World::new(2).await;
    let id = w.mint(&w.alice).await;
    assert_reverts(&bind(&w, &w.bob, &id, DEST).await, "only the note owner can do this");
    assert_reverts(&bind(&w, &w.alice, &id, "not an address").await, "");
    assert!(bind(&w, &w.alice, &id, DEST).await.json::<bool>().unwrap());
    assert_reverts(&bind(&w, &w.alice, &id, THIEF).await, "the heir is already fixed");
    assert_eq!(w.note(&id).await.unwrap()["heir"], DEST);

    let f = w.fund(&id, 50_000, 6).await;
    assert!(w.attest(&w.alice, &id, &f).await.is_success());
    assert_eq!(w.state(&id).await, "Sealed");

    // the link changes hands: the new holder is a thief
    assert!(w.transfer(&w.alice, &id, w.bob.id().as_str()).await.is_success());
    assert_reverts(&bind(&w, &w.bob, &id, THIEF).await, "the heir is fixed before the note is funded");
    assert_reverts(&w.unseal(&w.bob, &id, THIEF, 5).await, "this note sweeps only to its heir");
    assert_eq!(w.state(&id).await, "Sealed");

    // the only valid sweep goes to the bound address
    assert!(w.unseal(&w.bob, &id, DEST, 5).await.json::<bool>().unwrap());
    assert_eq!(w.state(&id).await, "Unsealed");
    let sweep = &w.note(&id).await.unwrap()["sweep"];
    assert!(sweep["signed_tx"].is_string());
}

#[tokio::test]
async fn an_unbound_note_still_sweeps_anywhere() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert!(w.note(&id).await.unwrap()["heir"].is_null());
    assert!(w.unseal(&w.alice, &id, THIEF, 5).await.json::<bool>().unwrap());
}

#[tokio::test]
async fn the_heir_cannot_be_bound_after_funding() {
    let w = World::new(2).await;
    let (id, _) = w.sealed_note(&w.alice, 50_000).await;
    assert_reverts(&bind(&w, &w.alice, &id, DEST).await, "the heir is fixed before the note is funded");
}
