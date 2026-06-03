use flow_rs::{
    rust_delete_key, rust_get_key, rust_get_key_restricted, rust_set_key, rust_set_key_restricted,
};
use uuid::Uuid;

fn fresh_service() -> String {
    format!("flow-rs-test-{}", Uuid::new_v4().simple())
}

#[test]
fn round_trip_set_then_get() {
    let svc = fresh_service();
    let name = "round-trip";
    let val = "s3cret-value";

    rust_set_key(&svc, name, val).expect("set_key failed");
    let got = rust_get_key(&svc, name).expect("get_key failed");
    assert_eq!(got.as_deref(), Some(val));

    rust_delete_key(&svc, name).expect("delete_key failed");
}

#[test]
fn get_absent_returns_none() {
    let svc = fresh_service();
    let got = rust_get_key(&svc, "never-set").expect("get_key failed");
    assert_eq!(got, None);
}

#[test]
fn overwrite_value() {
    let svc = fresh_service();
    let name = "overwrite";

    rust_set_key(&svc, name, "first").expect("set_key #1 failed");
    rust_set_key(&svc, name, "second").expect("set_key #2 failed");
    let got = rust_get_key(&svc, name).expect("get_key failed");
    assert_eq!(got.as_deref(), Some("second"));

    rust_delete_key(&svc, name).expect("delete_key failed");
}

#[test]
fn restricted_round_trip_same_binary() {
    // Same-binary writer + reader: ACL trusts this test binary on both
    // calls, so no SecurityAgent prompt fires.
    let svc = fresh_service();
    let name = "restricted-round-trip";
    let val = "r3stricted-s3cret";

    rust_set_key_restricted(&svc, name, val).expect("set_key_restricted failed");
    let got = rust_get_key_restricted(&svc, name).expect("get_key_restricted failed");
    assert_eq!(got.as_deref(), Some(val));

    rust_delete_key(&svc, name).expect("delete_key failed");
}

#[test]
fn restricted_get_absent_returns_none() {
    let svc = fresh_service();
    let got = rust_get_key_restricted(&svc, "never-set").expect("get_key_restricted failed");
    assert_eq!(got, None);
}
