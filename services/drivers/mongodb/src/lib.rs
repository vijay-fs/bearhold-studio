//! MongoDB driver. Lives outside the SQL-shaped `Driver` trait — none of
//! the trait's row/column/SQL semantics map cleanly onto a document
//! store, so we expose document-shaped methods directly. The frontend
//! dispatches by `profile.engine` and calls the matching Tauri command.

use std::sync::Arc;

use dashmap::DashMap;
use dbstudio_core::{
    secrets::{self, Slot},
    AuthMethod, ConnectionProfile, DbError, Result, TlsMode,
};
use futures_util::stream::TryStreamExt;
use mongodb::bson::{self, Bson, Document};
use mongodb::{
    options::{ClientOptions, FindOptions},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Cached MongoDB clients keyed by `ConnectionProfile.id`. A client owns
/// its own connection pool internally; we just hold onto the handle so
/// repeated commands reuse the same pool.
pub struct MongoDriver {
    clients: Arc<DashMap<Uuid, Client>>,
}

impl MongoDriver {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(DashMap::new()),
        }
    }

    async fn client_for(&self, profile: &ConnectionProfile) -> Result<Client> {
        if let Some(c) = self.clients.get(&profile.id) {
            return Ok(c.clone());
        }
        let uri = build_uri(profile).await?;
        let mut opts = ClientOptions::parse(&uri).await.map_err(map_mongo_err)?;
        // Identify ourselves so server-side metrics group dbstudio traffic
        // separately from random app traffic. Pure cosmetic.
        opts.app_name = Some("dbstudio".to_string());
        let client = Client::with_options(opts).map_err(map_mongo_err)?;
        self.clients.insert(profile.id, client.clone());
        Ok(client)
    }

    /// Quick reachability check. The mongo driver lazy-opens TCP on the
    /// first operation, so we run a `ping` here to surface auth/network
    /// errors at "Test connection" time rather than later.
    pub async fn ping(&self, profile: &ConnectionProfile) -> Result<()> {
        let client = self.client_for(profile).await?;
        client
            .database("admin")
            .run_command(bson::doc! { "ping": 1 })
            .await
            .map_err(map_mongo_err)?;
        Ok(())
    }

    pub async fn list_databases(&self, profile: &ConnectionProfile) -> Result<Vec<String>> {
        let client = self.client_for(profile).await?;
        let names = client.list_database_names().await.map_err(map_mongo_err)?;
        // Server-internal databases the user almost never wants to see in
        // the sidebar. They still exist and admins can access via raw
        // commands; we just don't surface them on the default list.
        let mut filtered: Vec<String> = names
            .into_iter()
            .filter(|n| n != "admin" && n != "config" && n != "local")
            .collect();
        filtered.sort();
        Ok(filtered)
    }

    pub async fn list_collections(
        &self,
        profile: &ConnectionProfile,
        database: &str,
    ) -> Result<Vec<String>> {
        let client = self.client_for(profile).await?;
        let mut names = client
            .database(database)
            .list_collection_names()
            .await
            .map_err(map_mongo_err)?;
        // Hide internal `system.*` collections by default — noise for
        // the typical browse flow.
        names.retain(|n| !n.starts_with("system."));
        names.sort();
        Ok(names)
    }

    /// Run a `find` against a collection. Filter / sort / projection
    /// arrive as JSON values from the frontend so users can type
    /// whatever they want into the filter box without us building a
    /// query DSL on top.
    pub async fn find(
        &self,
        profile: &ConnectionProfile,
        req: FindRequest,
    ) -> Result<FindResponse> {
        let client = self.client_for(profile).await?;
        let collection = client
            .database(&req.database)
            .collection::<Document>(&req.collection);

        let filter = json_to_doc(
            req.filter
                .clone()
                .unwrap_or(Value::Object(Default::default())),
        )?;
        let sort = match req.sort {
            Some(v) => Some(json_to_doc(v)?),
            None => None,
        };
        let projection = match req.projection {
            Some(v) => Some(json_to_doc(v)?),
            None => None,
        };

        // Cap at 1000 rows per page — keeps a runaway "filter on an
        // unindexed huge collection" from monopolising the renderer.
        let limit = req.limit.unwrap_or(100).min(1000) as i64;
        let skip = req.skip.unwrap_or(0) as u64;

        let opts = FindOptions::builder()
            .limit(limit)
            .skip(skip)
            .sort(sort)
            .projection(projection)
            .build();

        let started = std::time::Instant::now();
        let cursor = collection
            .find(filter)
            .with_options(opts)
            .await
            .map_err(map_mongo_err)?;

        let docs: Vec<Document> = cursor.try_collect().await.map_err(map_mongo_err)?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let json_docs: Vec<Value> = docs.iter().map(doc_to_json).collect();

        // `estimated_document_count` is cheap but approximate. We label
        // it as such in the UI ("~N total") so users don't get confused
        // when adding/removing one row doesn't bump the count.
        let approx_total = collection
            .estimated_document_count()
            .await
            .map_err(map_mongo_err)?;

        Ok(FindResponse {
            documents: json_docs,
            approx_total,
            elapsed_ms,
        })
    }

    /// Insert one document into a collection. Returns the inserted
    /// `_id` (extended-JSON form, so ObjectId comes back as
    /// `{"$oid": "..."}` for round-trip with the rest of the UI).
    pub async fn insert_one(
        &self,
        profile: &ConnectionProfile,
        database: &str,
        collection: &str,
        document: Value,
    ) -> Result<Value> {
        let client = self.client_for(profile).await?;
        let coll = client.database(database).collection::<Document>(collection);
        let doc = json_to_doc(document)?;
        let result = coll.insert_one(doc).await.map_err(map_mongo_err)?;
        Ok(Bson::from(result.inserted_id).into_canonical_extjson())
    }

    /// Replace one document identified by `_id`. We use replace_one
    /// rather than update_one so the user-edited JSON is the new
    /// document verbatim — no merge gymnastics, no field deletions
    /// silently failing. The `_id` is taken from the document body
    /// since the frontend always sends a complete document for edit.
    pub async fn replace_one(
        &self,
        profile: &ConnectionProfile,
        database: &str,
        collection: &str,
        document: Value,
    ) -> Result<u64> {
        let client = self.client_for(profile).await?;
        let coll = client.database(database).collection::<Document>(collection);
        let mut doc = json_to_doc(document)?;
        let id = doc
            .remove("_id")
            .ok_or_else(|| DbError::InvalidInput("document must include _id for replace".into()))?;
        let filter = bson::doc! { "_id": id };
        let result = coll.replace_one(filter, doc).await.map_err(map_mongo_err)?;
        Ok(result.modified_count)
    }

    /// Delete one document by `_id`. Returns the number of deleted
    /// documents (0 or 1).
    pub async fn delete_one(
        &self,
        profile: &ConnectionProfile,
        database: &str,
        collection: &str,
        id: Value,
    ) -> Result<u64> {
        let client = self.client_for(profile).await?;
        let coll = client.database(database).collection::<Document>(collection);
        let filter = bson::doc! { "_id": json_to_bson(id)? };
        let result = coll.delete_one(filter).await.map_err(map_mongo_err)?;
        Ok(result.deleted_count)
    }

    /// Drop the cached client. Next call lazily reopens the pool.
    pub async fn disconnect(&self, profile: &ConnectionProfile) -> Result<()> {
        self.clients.remove(&profile.id);
        Ok(())
    }
}

impl Default for MongoDriver {
    fn default() -> Self {
        Self::new()
    }
}

// ---- wire types --------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct FindRequest {
    pub database: String,
    pub collection: String,
    #[serde(default)]
    pub filter: Option<Value>,
    #[serde(default)]
    pub sort: Option<Value>,
    #[serde(default)]
    pub projection: Option<Value>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub skip: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FindResponse {
    pub documents: Vec<Value>,
    /// `estimated_document_count` — fast, approximate. UI labels it as such.
    pub approx_total: u64,
    pub elapsed_ms: u64,
}

// ---- helpers -----------------------------------------------------------

/// Build a `mongodb://` URI from the profile. Honors username/password
/// from the auth slot (looked up via secrets), `database` for the
/// default authSource, and TLS from the profile's `tls` field.
async fn build_uri(profile: &ConnectionProfile) -> Result<String> {
    let mut user = String::new();
    let mut pass = String::new();
    if let AuthMethod::Password {
        username,
        password_ref,
    } = &profile.auth
    {
        user = username.clone();
        let _ = password_ref; // ref string is the storage handle; we read by slot
        if let Ok(Some(p)) = secrets::get(profile.id, Slot::Password).await {
            pass = p;
        }
    }

    let host = if profile.host.is_empty() {
        "localhost".to_string()
    } else {
        profile.host.clone()
    };
    let port = if profile.port == 0 {
        27017
    } else {
        profile.port
    };

    let creds = if user.is_empty() {
        String::new()
    } else {
        format!("{}:{}@", percent_encode(&user), percent_encode(&pass),)
    };
    let tls = matches!(
        profile.tls,
        TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull
    );
    let tls_qs = if tls { "?tls=true" } else { "" };

    let db_segment = if profile.database.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", profile.database)
    };

    Ok(format!(
        "mongodb://{creds}{host}:{port}{db_segment}{tls_qs}"
    ))
}

/// Minimal percent-encoder for username/password segments. Avoids pulling
/// in the `urlencoding` crate for what's really just five chars we care
/// about. Anything not in the unreserved set gets `%HH` encoded.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        // RFC 3986 unreserved chars are safe; everything else gets
        // percent-encoded so a `:` or `@` in a password can't break
        // the URI parse.
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn map_mongo_err(e: mongodb::error::Error) -> DbError {
    use mongodb::error::ErrorKind;
    match *e.kind {
        ErrorKind::Authentication { .. } => DbError::AuthFailed(e.to_string()),
        ErrorKind::ServerSelection { .. } | ErrorKind::Io(_) => DbError::Connection(e.to_string()),
        _ => DbError::Internal(e.to_string()),
    }
}

/// Convert a serde_json::Value into a BSON Document. Top-level must be an
/// object — non-objects are rejected as invalid filter input.
fn json_to_doc(v: Value) -> Result<Document> {
    let bson_value = json_to_bson(v)?;
    match bson_value {
        Bson::Document(d) => Ok(d),
        _ => Err(DbError::InvalidInput(
            "filter / sort / projection must be a JSON object".into(),
        )),
    }
}

/// Convert a serde_json::Value into a BSON value via bson's extended-
/// JSON deserializer (accepts BOTH canonical and relaxed forms).
///
/// This must be the exact inverse of `doc_to_json`, which renders
/// documents as canonical extJSON: `{"$numberInt":"5"}`, `{"$date":...}`,
/// `{"$oid":...}`, etc. The previous hand-rolled version only reversed
/// `$oid`, so editing any document with a number/date/binary field
/// re-saved those wrappers as literal nested documents — silent
/// corruption of every non-string field.
///
/// Query-operator keys (`$gt`, `$in`, ...) are NOT extJSON keywords;
/// bson's parser passes them through as plain documents, so filters,
/// sorts, and projections still work through this same path.
fn json_to_bson(v: Value) -> Result<Bson> {
    Bson::try_from(v)
        .map_err(|e| DbError::InvalidInput(format!("invalid JSON / extended JSON: {e}")))
}

/// Render a BSON Document as MongoDB extended-JSON — the shape Compass /
/// mongosh users recognise. ObjectId becomes `{"$oid": ...}`, DateTime
/// becomes ISO 8601 strings, etc. The function is infallible because
/// every Document round-trips through Bson cleanly.
fn doc_to_json(doc: &Document) -> Value {
    Bson::Document(doc.clone()).into_canonical_extjson()
}
