//! Live tests against the docker test matrix (redis7 on 6379).
//! Run: cargo test -p dbstudio-driver-redis --test live -- --ignored

use dbstudio_core::{AuthMethod, ConnectionProfile, DatabaseEngine, TlsMode};
use dbstudio_driver_redis::{RedisDriver, RedisValue};
use uuid::Uuid;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4(),
        name: "e2e-redis".into(),
        engine: DatabaseEngine::Redis,
        host: "127.0.0.1".into(),
        port: 6379,
        database: String::new(),
        auth: AuthMethod::None,
        tls: TlsMode::Disable,
        ssh_tunnel: None,
        options: Default::default(),
        file_path: None,
    }
}

#[tokio::test]
#[ignore = "needs docker redis7"]
async fn string_ttl_rename_lifecycle() {
    let driver = RedisDriver::new();
    let p = profile();
    for k in ["e2e:k1", "e2e:k2", "e2e:k3"] {
        let _ = driver.delete(&p, k).await;
    }

    driver.set_string(&p, "e2e:k1", "hello").await.expect("SET");
    let d = driver.key_details(&p, "e2e:k1").await.expect("details");
    assert!(matches!(d.value, RedisValue::String(ref s) if s == "hello"));
    assert_eq!(d.ttl_seconds, Some(-1), "fresh key has no TTL");

    assert!(driver.set_ttl(&p, "e2e:k1", Some(120)).await.expect("EXPIRE"));
    let d = driver.key_details(&p, "e2e:k1").await.expect("details");
    assert!(d.ttl_seconds.unwrap_or(0) > 0, "TTL applied");

    assert!(driver.set_ttl(&p, "e2e:k1", None).await.expect("PERSIST"));
    let d = driver.key_details(&p, "e2e:k1").await.expect("details");
    assert_eq!(d.ttl_seconds, Some(-1), "TTL removed");

    assert!(driver.set_ttl(&p, "e2e:k1", Some(0)).await.is_err(), "zero TTL rejected");

    driver.rename(&p, "e2e:k1", "e2e:k2").await.expect("RENAME");
    let d = driver.key_details(&p, "e2e:k2").await.expect("details");
    assert!(matches!(d.value, RedisValue::String(ref s) if s == "hello"));

    // RENAMENX: refuse to clobber.
    driver.set_string(&p, "e2e:k3", "occupied").await.expect("SET");
    let clobber = driver.rename(&p, "e2e:k2", "e2e:k3").await;
    assert!(clobber.is_err(), "rename onto existing key must error");
    let d = driver.key_details(&p, "e2e:k3").await.expect("details");
    assert!(matches!(d.value, RedisValue::String(ref s) if s == "occupied"), "target untouched");

    for k in ["e2e:k2", "e2e:k3"] {
        driver.delete(&p, k).await.expect("cleanup");
    }
}

#[tokio::test]
#[ignore = "needs docker redis7"]
async fn stream_preview() {
    let driver = RedisDriver::new();
    let p = profile();
    let _ = driver.delete(&p, "e2e:stream").await;

    // Seed with the redis crate directly — the browser is read-only
    // for streams, so the driver has no XADD of its own.
    let client = redis::Client::open("redis://127.0.0.1:6379").expect("client");
    let mut conn = client.get_multiplexed_async_connection().await.expect("conn");
    for i in 0..3 {
        let _: String = redis::cmd("XADD")
            .arg("e2e:stream")
            .arg("*")
            .arg("event")
            .arg(format!("evt-{i}"))
            .arg("n")
            .arg(i)
            .query_async(&mut conn)
            .await
            .expect("XADD");
    }

    let d = driver.key_details(&p, "e2e:stream").await.expect("details");
    match d.value {
        RedisValue::Stream { entries, total } => {
            assert_eq!(total, 3, "XLEN");
            assert_eq!(entries.len(), 3, "entries decoded");
            assert_eq!(entries[0].1[0], "event");
            assert_eq!(entries[0].1[1], "evt-0");
        }
        other => panic!("expected stream value, got {other:?}"),
    }
    driver.delete(&p, "e2e:stream").await.expect("cleanup");
}
