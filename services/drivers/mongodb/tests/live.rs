//! Live tests against the docker test matrix (mongo7 on 27017).
//! Run: cargo test -p dbstudio-driver-mongodb --test live -- --ignored

use dbstudio_core::{AuthMethod, ConnectionProfile, DatabaseEngine, TlsMode};
use dbstudio_driver_mongodb::MongoDriver;
use serde_json::json;
use uuid::Uuid;

fn profile() -> ConnectionProfile {
    ConnectionProfile {
        id: Uuid::new_v4(),
        name: "e2e-mongo".into(),
        engine: DatabaseEngine::MongoDb,
        host: "127.0.0.1".into(),
        port: 27017,
        database: String::new(),
        auth: AuthMethod::None,
        tls: TlsMode::Disable,
        ssh_tunnel: None,
        options: Default::default(),
        file_path: None,
    }
}

const DB: &str = "e2e_test";
const COLL: &str = "e2e_things";

#[tokio::test]
#[ignore = "needs docker mongo7"]
async fn collection_index_and_aggregation_lifecycle() {
    let driver = MongoDriver::new();
    let p = profile();

    // Fresh slate.
    let _ = driver.drop_collection(&p, DB, COLL).await;
    driver
        .create_collection(&p, DB, COLL)
        .await
        .expect("create collection");
    let colls = driver.list_collections(&p, DB).await.expect("list");
    assert!(colls.contains(&COLL.to_string()), "collection listed");

    for (name, balance) in [("alice", 120.5), ("bob", 0.0), ("carol", 120.5)] {
        driver
            .insert_one(&p, DB, COLL, json!({ "name": name, "balance": balance }))
            .await
            .expect("insert");
    }

    // Aggregation: group by balance, count.
    let result = driver
        .aggregate(
            &p,
            DB,
            COLL,
            vec![
                json!({ "$match": { "balance": { "$gt": 0 } } }),
                json!({ "$group": { "_id": "$balance", "n": { "$sum": 1 } } }),
            ],
            None,
        )
        .await
        .expect("aggregate");
    assert_eq!(result.documents.len(), 1, "one balance group over 0");
    let n = result.documents[0]["n"].as_i64().or_else(|| {
        result.documents[0]["n"]["$numberInt"]
            .as_str()
            .and_then(|s| s.parse().ok())
    });
    assert_eq!(n, Some(2), "two docs share balance 120.5");

    // Index lifecycle.
    let created = driver
        .create_index(&p, DB, COLL, json!({ "name": 1 }), true, Some("uq_name".into()))
        .await
        .expect("create index");
    assert_eq!(created, "uq_name");
    let indexes = driver.list_indexes(&p, DB, COLL).await.expect("list indexes");
    let names: Vec<String> = indexes
        .iter()
        .filter_map(|i| i["name"].as_str().map(String::from))
        .collect();
    assert!(names.contains(&"_id_".to_string()), "default _id_ index listed");
    assert!(names.contains(&"uq_name".to_string()), "created index listed");
    let uq = indexes.iter().find(|i| i["name"] == "uq_name").unwrap();
    assert_eq!(uq["unique"], json!(true), "unique flag surfaced");

    // Unique index must actually enforce.
    let dup = driver
        .insert_one(&p, DB, COLL, json!({ "name": "alice", "balance": 1 }))
        .await;
    assert!(dup.is_err(), "duplicate insert must violate uq_name");

    driver
        .drop_index(&p, DB, COLL, "uq_name")
        .await
        .expect("drop index");
    let after: Vec<String> = driver
        .list_indexes(&p, DB, COLL)
        .await
        .expect("list after drop")
        .iter()
        .filter_map(|i| i["name"].as_str().map(String::from))
        .collect();
    assert!(!after.contains(&"uq_name".to_string()), "index gone");

    driver.drop_collection(&p, DB, COLL).await.expect("drop collection");
    let colls = driver.list_collections(&p, DB).await.expect("list");
    assert!(!colls.contains(&COLL.to_string()), "collection gone");
}
