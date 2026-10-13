use anyhow::{bail, ensure, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
pub const PROTOCOL: &str = "pickdrop-peer-v1";
pub const ANIMALS: [&str; 10] = [
    "cat", "sheep", "monkey", "dog", "chick", "lizard", "alpaca", "rabbit", "otter", "capybara",
];
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), canonical(&m[k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => v.to_string(),
    }
}
pub fn random(n: usize) -> String {
    let mut b = vec![0; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}
pub fn signing(secret: &str) -> Result<SigningKey> {
    let bytes: [u8; 32] = hex::decode(secret)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid private key"))?;
    Ok(SigningKey::from_bytes(&bytes))
}
pub fn sign(mut body: Value, key: &SigningKey) -> Value {
    let sig = hex::encode(key.sign(canonical(&body).as_bytes()).to_bytes());
    body["signature"] = sig.into();
    body
}
pub fn verify(v: &Value, public: &str) -> Result<()> {
    let mut body = v.clone();
    let sig = body
        .as_object_mut()
        .and_then(|b| b.remove("signature"))
        .and_then(|s| s.as_str().map(str::to_owned))
        .ok_or_else(|| anyhow::anyhow!("Missing signature"))?;
    body.as_object_mut().unwrap().remove("eventId");
    let pk: [u8; 32] = hex::decode(public)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid key"))?;
    let signature = Signature::from_slice(&hex::decode(sig)?)?;
    VerifyingKey::from_bytes(&pk)?.verify(canonical(&body).as_bytes(), &signature)?;
    Ok(())
}
pub fn hash(v: &Value) -> String {
    hex::encode(Sha256::digest(canonical(v).as_bytes()))
}
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}
fn validhex(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
#[derive(Clone)]
pub struct Replica {
    pub genesis: Value,
    pub events: BTreeMap<String, Value>,
    pub heads: BTreeSet<String>,
    pub state: Value,
    pub revision: u64,
    pub validations: u64,
    pub replays: HashMap<String, i64>,
    /// Creator-signed removal receipts received without disclosing missing history.
    pub revocations: BTreeMap<String, Value>,
}
impl Replica {
    pub fn new(genesis: Value, events: Vec<Value>) -> Result<Self> {
        ensure!(
            s(&genesis, "protocol") == PROTOCOL && uuid(&genesis["groupId"]),
            "Invalid genesis"
        );
        verify(&genesis, s(&genesis, "creatorPublicKey"))?;
        ensure!(
            genesis["creator"]["publicKey"] == genesis["creatorPublicKey"]
                && genesis["creator"]["id"] == genesis["creatorDeviceId"],
            "Invalid creator"
        );
        let mut r = Self {
            genesis,
            events: BTreeMap::new(),
            heads: BTreeSet::new(),
            state: Value::Null,
            revision: 0,
            validations: 0,
            replays: HashMap::new(),
            revocations: BTreeMap::new(),
        };
        r.state = r.project(None);
        r.merge(events)?;
        Ok(r)
    }
    pub fn from_snapshot(saved: &Value) -> Result<Self> {
        let mut replica = Self::new(
            saved["genesis"].clone(),
            saved["events"].as_array().cloned().unwrap_or_default(),
        )?;
        // Persisted receipts are still independently authenticated, never trusted as flags.
        for receipt in saved["revocations"].as_array().into_iter().flatten() {
            replica.accept_revocation(receipt.clone(), s(&receipt["payload"], "deviceId"))?;
        }
        Ok(replica)
    }
    /// Authenticate a targeted removal without needing its (possibly private) parent events.
    /// Creator removal authority is unconditional; the full DAG remains the authority for rejoining.
    pub fn verify_revocation(&self, receipt: &Value, target_id: &str) -> Result<()> {
        ensure!(
            receipt["groupId"] == self.genesis["groupId"]
                && receipt["authorDeviceId"] == self.genesis["creatorDeviceId"]
                && receipt["authorPublicKey"] == self.genesis["creatorPublicKey"]
                && s(&receipt, "type") == "member.remove"
                && s(&receipt["payload"], "deviceId") == target_id
                && uuid(&receipt["payload"]["deviceId"])
                && receipt["payload"]["deviceId"] != self.genesis["creatorDeviceId"]
                && receipt["clock"]
                    .as_u64()
                    .is_some_and(|clock| clock > 0 && clock <= 9007199254740991)
                && receipt["parents"]
                    .as_array()
                    .is_some_and(|parents| parents.len() <= 256 && parents.iter().all(validhex)),
            "Invalid targeted revocation"
        );
        let mut signed = receipt.clone();
        signed.as_object_mut().unwrap().remove("eventId");
        ensure!(
            hash(&signed) == s(&receipt, "eventId"),
            "Invalid revocation digest"
        );
        verify(&receipt, s(&self.genesis, "creatorPublicKey"))?;
        Ok(())
    }
    pub fn accept_revocation(&mut self, receipt: Value, target_id: &str) -> Result<usize> {
        self.verify_revocation(&receipt, target_id)?;
        let id = s(&receipt, "eventId").to_string();
        if let Some(event) = self.events.get(&id) {
            ensure!(event == &receipt, "Conflicting revocation");
            // Already reflected in the DAG, possibly superseded by a creator-approved rejoin.
            return Ok(0);
        }
        if let Some(previous) = self.revocations.get(&id) {
            ensure!(previous == &receipt, "Conflicting revocation");
            return Ok(0);
        }
        self.revocations.insert(id, receipt);
        self.state = self.project(None);
        self.revision += 1;
        Ok(1)
    }
    /// Only an identity previously admitted to this group can receive its own removal receipt.
    pub fn revocation_for(&self, id: &str, key: &str) -> Option<Value> {
        if self.member(id, key)
            || !self.events.values().any(|event| {
                s(event, "type") == "member.add"
                    && s(&event["payload"], "id") == id
                    && s(&event["payload"], "publicKey") == key
            })
        {
            return None;
        }
        self.ordered(None)
            .into_iter()
            .rev()
            .find(|event| {
                s(event, "type") == "member.remove"
                    && s(&event["payload"], "deviceId") == id
                    && event["authorPublicKey"] == self.genesis["creatorPublicKey"]
            })
            .cloned()
    }
    pub fn ordered(&self, subset: Option<&HashSet<String>>) -> Vec<&Value> {
        let mut e: Vec<_> = self
            .events
            .iter()
            .filter(|(id, _)| subset.is_none_or(|set| set.contains(*id)))
            .map(|(_, e)| e)
            .collect();
        e.sort_by(|a, b| {
            a["clock"]
                .as_u64()
                .cmp(&b["clock"].as_u64())
                .then_with(|| s(a, "eventId").cmp(s(b, "eventId")))
        });
        e
    }
    fn past(&self, e: &Value) -> HashSet<String> {
        let mut result = HashSet::new();
        let mut todo: Vec<String> = e["parents"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect();
        while let Some(id) = todo.pop() {
            if !result.insert(id.clone()) {
                continue;
            }
            if let Some(parent) = self.events.get(&id) {
                todo.extend(
                    parent["parents"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|p| p.as_str().map(str::to_owned)),
                );
            }
        }
        result
    }
    fn extends_all(&self, e: &Value) -> bool {
        e["parents"].as_array().is_some_and(|ps| {
            ps.iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect::<BTreeSet<_>>()
                == self.heads
        })
    }
    /// Checkpoint only changed IDs and cached projection. Previously validated events are retained.
    pub fn merge_authorized(
        &mut self,
        incoming: Vec<Value>,
        sender_id: &str,
        sender_key: &str,
        previously_allowed: bool,
    ) -> Result<usize> {
        let added: Vec<_> = incoming
            .iter()
            .filter(|e| !self.events.contains_key(s(e, "eventId")))
            .map(|e| s(e, "eventId").to_string())
            .collect();
        if added.is_empty() {
            let count = self.merge(incoming)?;
            ensure!(
                previously_allowed || self.member(sender_id, sender_key),
                "Inactive sender"
            );
            return Ok(count);
        }
        let heads = self.heads.clone();
        let state = self.state.clone();
        let revision = self.revision;
        let count = self.merge(incoming)?;
        if !previously_allowed && !self.member(sender_id, sender_key) {
            for id in added {
                self.events.remove(&id);
            }
            self.heads = heads;
            self.state = state;
            self.revision = revision;
            bail!("Inactive sender");
        }
        Ok(count)
    }
    pub fn project(&self, subset: Option<&HashSet<String>>) -> Value {
        let ordered = self.ordered(subset);
        let mut removed: HashMap<String, Vec<&Value>> = HashMap::new();
        let mut choices: HashMap<String, Vec<&Value>> = HashMap::new();
        for e in &ordered {
            match s(e, "type") {
                "member.remove" => removed
                    .entry(s(&e["payload"], "deviceId").into())
                    .or_default()
                    .push(e),
                "member.leave" => removed
                    .entry(s(e, "authorDeviceId").into())
                    .or_default()
                    .push(e),
                "member.add" => choices
                    .entry(s(&e["payload"], "id").into())
                    .or_default()
                    .push(e),
                _ => {}
            }
        }
        let selected: HashMap<_, _> = choices
            .iter()
            .map(|(id, grants)| {
                let admin: Vec<_> = grants
                    .iter()
                    .copied()
                    .filter(|e| e["authorPublicKey"] == self.genesis["creatorPublicKey"])
                    .collect();
                let pick = admin.last().copied().unwrap_or(*grants.last().unwrap());
                let conflict = admin.is_empty()
                    && grants
                        .iter()
                        .map(|e| s(&e["payload"], "publicKey"))
                        .collect::<HashSet<_>>()
                        .len()
                        > 1;
                (id.clone(), (pick, conflict))
            })
            .collect();
        let allowed = |e: &Value| -> bool {
            if removed.get(s(e, "authorDeviceId")).is_some_and(|rs| {
                rs.iter().any(|r| {
                    (s(r, "type") != "member.leave" || r["authorPublicKey"] == e["authorPublicKey"])
                        && r["eventId"] != e["eventId"]
                        && !self.past(r).contains(s(e, "eventId"))
                        && !self.past(e).contains(s(r, "eventId"))
                })
            }) {
                return false;
            }
            if let Some((g, conflict)) = selected.get(s(e, "authorDeviceId")) {
                if *conflict {
                    return false;
                }
                return g["payload"]["publicKey"] == e["authorPublicKey"]
                    || self.past(g).contains(s(e, "eventId"));
            }
            true
        };
        let mut valid = HashSet::new();
        let authorized = |e: &Value, valid: &HashSet<String>| -> bool {
            (e["authorDeviceId"] == self.genesis["creatorDeviceId"]
                && e["authorPublicKey"] == self.genesis["creatorPublicKey"])
                || ordered.iter().any(|g| {
                    s(g, "type") == "member.add"
                        && g["payload"]["id"] == e["authorDeviceId"]
                        && g["payload"]["publicKey"] == e["authorPublicKey"]
                        && self.past(e).contains(s(g, "eventId"))
                        && valid.contains(s(g, "eventId"))
                })
        };
        for e in &ordered {
            if s(e, "type") == "member.add" && allowed(e) && authorized(e, &valid) {
                valid.insert(s(e, "eventId").to_string());
            }
        }
        let mut members: BTreeMap<String, Value> = BTreeMap::from([(
            s(&self.genesis, "creatorDeviceId").into(),
            self.genesis["creator"].clone(),
        )]);
        let mut messages: BTreeMap<String, Value> = BTreeMap::new();
        let mut conflicts = HashSet::new();
        let mut name = self.genesis["name"].clone();
        let mut animal = self.genesis["animalId"].clone();
        if animal.is_null() {
            let hash = s(&self.genesis, "groupId")
                .encode_utf16()
                .fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(c as u32));
            animal = ANIMALS[hash as usize % 10].into();
        }
        let mut dissolved = false;
        for e in &ordered {
            let typ = s(e, "type");
            if !allowed(e) && typ != "member.remove" && typ != "member.leave" {
                continue;
            }
            let p = &e["payload"];
            match typ {
                "member.add" => {
                    let id = s(p, "id");
                    if valid.contains(s(e, "eventId"))
                        && selected.get(id).is_some_and(|(g, c)| {
                            !*c && g["payload"]["publicKey"] == p["publicKey"]
                        })
                        && removed.get(id).is_none_or(|rs| {
                            rs.iter()
                                .filter(|r| {
                                    s(r, "type") != "member.leave"
                                        || r["authorPublicKey"] == p["publicKey"]
                                })
                                .all(|r| self.past(e).contains(s(r, "eventId")))
                        })
                    {
                        members.insert(id.into(), p.clone());
                    }
                }
                "rename" => {
                    name = p["name"].clone();
                    if ANIMALS.contains(&s(p, "animalId")) {
                        animal = p["animalId"].clone()
                    }
                }
                "dissolve" => dissolved = true,
                "message" if authorized(e, &valid) => {
                    let id = s(p, "id");
                    if let Some(prev) = messages.get(id) {
                        let mut prev = prev.clone();
                        prev.as_object_mut().unwrap().remove("peerEventId");
                        if prev != *p {
                            conflicts.insert(id.to_string());
                        }
                    } else {
                        let mut m = p.clone();
                        m["peerEventId"] = e["eventId"].clone();
                        messages.insert(id.into(), m);
                    }
                }
                _ => {}
            }
        }
        for (id, rs) in removed {
            let rs: Vec<_> = rs
                .into_iter()
                .filter(|r| {
                    s(r, "type") != "member.leave"
                        || members
                            .get(&id)
                            .is_some_and(|m| m["publicKey"] == r["authorPublicKey"])
                })
                .collect();
            if !rs.is_empty()
                && !ordered.iter().any(|e| {
                    s(e, "type") == "member.add"
                        && s(&e["payload"], "id") == id
                        && valid.contains(s(e, "eventId"))
                        && rs.iter().all(|r| self.past(e).contains(s(r, "eventId")))
                })
            {
                members.remove(&id);
            }
        }
        for (id, receipt) in &self.revocations {
            if subset.is_none() && !self.events.contains_key(id) {
                members.remove(s(&receipt["payload"], "deviceId"));
            }
        }
        let messages: Vec<_> = ordered
            .iter()
            .filter(|e| s(e, "type") == "message")
            .filter_map(|e| messages.remove(s(&e["payload"], "id")))
            .filter(|m| !conflicts.contains(s(m, "id")))
            .collect();
        json!({"id":self.genesis["groupId"],"name":name,"animalId":animal,"members":members.values().collect::<Vec<_>>(),"messages":messages,"dissolved":dissolved})
    }
    fn validate(&self, e: &Value) -> Result<()> {
        ensure!(
            e["groupId"] == self.genesis["groupId"] && uuid(&e["authorDeviceId"]),
            "Invalid event group or author"
        );
        let parents = e["parents"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid parents"))?;
        ensure!(
            parents.len() <= 256
                && parents
                    .iter()
                    .all(|p| p.as_str().is_some_and(|id| self.events.contains_key(id))),
            "Missing parent"
        );
        let mut signed = e.clone();
        signed.as_object_mut().unwrap().remove("eventId");
        ensure!(hash(&signed) == s(e, "eventId"), "Invalid event digest");
        verify(e, s(e, "authorPublicKey"))?;
        let past = self.past(e);
        let state = if past.len() == self.events.len() && self.revocations.is_empty() {
            self.state.clone()
        } else {
            self.project(Some(&past))
        };
        ensure!(
            !state["dissolved"].as_bool().unwrap_or(false)
                && state["members"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == e["authorDeviceId"]
                        && m["publicKey"] == e["authorPublicKey"]),
            "Inactive event author"
        );
        let clock = parents
            .iter()
            .map(|p| self.events[p.as_str().unwrap()]["clock"].as_u64().unwrap())
            .max()
            .unwrap_or(0)
            + 1;
        ensure!(
            e["clock"].as_u64() == Some(clock) && clock <= 9007199254740991,
            "Invalid clock"
        );
        let p = &e["payload"];
        let creator = e["authorPublicKey"] == self.genesis["creatorPublicKey"];
        match s(e, "type") {
            "message" => {
                ensure!(
                    uuid(&p["id"])
                        && p["senderId"] == e["authorDeviceId"]
                        && p["senderName"].is_string()
                        && p["createdAt"].is_string(),
                    "Invalid message"
                );
                match s(p, "type") {
                    "text" => ensure!(
                        !s(p, "text").trim().is_empty()
                            && s(p, "text").encode_utf16().count() <= 10000,
                        "Invalid text"
                    ),
                    "file" => ensure!(
                        validhex(&p["sha256"])
                            && p["size"].as_u64().is_some_and(|n| n <= 9007199254740991)
                            && !s(p, "fileName").is_empty()
                            && !s(p, "fileName").contains(['\\', '/', '\0']),
                        "Invalid file"
                    ),
                    _ => bail!("Invalid message type"),
                }
            }
            "member.add" => {
                ensure!(
                    uuid(&p["id"]) && validhex(&p["publicKey"]) && !s(p, "name").trim().is_empty(),
                    "Invalid member"
                );
                ensure!(
                    p["id"] != self.genesis["creatorDeviceId"]
                        || p["publicKey"] == self.genesis["creatorPublicKey"],
                    "Cannot replace creator"
                );
                if !creator {
                    ensure!(
                        !self.ordered(Some(&past)).iter().any(|e| (s(e, "type")
                            == "member.remove"
                            && e["payload"]["deviceId"] == p["id"])
                            || (s(e, "type") == "member.add"
                                && e["payload"]["id"] == p["id"]
                                && e["authorPublicKey"] == self.genesis["creatorPublicKey"]
                                && e["payload"]["publicKey"] != p["publicKey"])),
                        "Only creator may restore identity"
                    );
                    ensure!(
                        !state["members"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|m| m["id"] == p["id"] && m["publicKey"] != p["publicKey"]),
                        "Only creator may replace identity"
                    );
                }
            }
            "member.remove" => ensure!(
                creator && uuid(&p["deviceId"]) && p["deviceId"] != self.genesis["creatorDeviceId"],
                "Only creator may remove members"
            ),
            "rename" => ensure!(
                creator
                    && !s(p, "name").trim().is_empty()
                    && s(p, "name").encode_utf16().count() <= 40
                    && (p.get("animalId").is_none() || ANIMALS.contains(&s(p, "animalId"))),
                "Invalid rename"
            ),
            "dissolve" => ensure!(creator, "Only creator may dissolve"),
            "member.leave" => {}
            _ => bail!("Unknown event"),
        };
        Ok(())
    }
    pub fn merge(&mut self, incoming: Vec<Value>) -> Result<usize> {
        ensure!(incoming.len() <= 50000, "Batch too large");
        let mut pending = BTreeMap::new();
        for e in incoming {
            let id = s(&e, "eventId").to_string();
            if let Some(stored) = self.events.get(&id) {
                ensure!(stored == &e, "Conflicting event")
            } else {
                ensure!(!id.is_empty(), "Missing event id");
                if let Some(previous) = pending.insert(id, e.clone()) {
                    ensure!(previous == e, "Conflicting batch event")
                }
            }
        }
        if pending.is_empty() {
            return Ok(0);
        }
        let original_heads = self.heads.clone();
        let original_state = self.state.clone();
        let mut added = Vec::new();
        let result = (|| -> Result<()> {
            while !pending.is_empty() {
                let ready: Vec<_> = pending
                    .iter()
                    .filter(|(_, e)| {
                        e["parents"].as_array().is_some_and(|ps| {
                            ps.iter()
                                .all(|p| p.as_str().is_some_and(|id| self.events.contains_key(id)))
                        })
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                ensure!(!ready.is_empty(), "Missing or cyclic ancestry");
                for id in ready {
                    let e = pending.remove(&id).unwrap();
                    self.validate(&e)?;
                    self.validations += 1;
                    let extends_all = self.extends_all(&e);
                    for p in e["parents"].as_array().unwrap() {
                        self.heads.remove(p.as_str().unwrap());
                    }
                    self.heads.insert(id.clone());
                    let fast_message = extends_all
                        && s(&e, "type") == "message"
                        && !self.ordered(None).iter().any(|old| {
                            s(old, "type") == "message"
                                && old["payload"]["id"] == e["payload"]["id"]
                        });
                    if fast_message {
                        let mut message = e["payload"].clone();
                        message["peerEventId"] = e["eventId"].clone();
                        self.state["messages"].as_array_mut().unwrap().push(message);
                    }
                    self.events.insert(id.clone(), e);
                    added.push(id);
                    if !fast_message {
                        self.state = self.project(None);
                    }
                }
            }
            Ok(())
        })();
        if let Err(err) = result {
            for id in added {
                self.events.remove(&id);
            }
            self.heads = original_heads;
            self.state = original_state;
            return Err(err);
        }
        // Full authenticated ancestry supersedes a limited receipt, including approved rejoins.
        self.revocations
            .retain(|id, _| !self.events.contains_key(id));
        self.revision += 1;
        Ok(added.len())
    }
    pub fn append(
        &mut self,
        typ: &str,
        payload: Value,
        device: &Value,
        key: &SigningKey,
    ) -> Result<Value> {
        ensure!(
            self.member(
                s(device, "id"),
                &hex::encode(key.verifying_key().to_bytes())
            ),
            "Inactive event author"
        );
        let parents: Vec<_> = self.heads.iter().cloned().collect();
        let clock = parents
            .iter()
            .map(|p| self.events[p]["clock"].as_u64().unwrap())
            .max()
            .unwrap_or(0)
            + 1;
        let mut e = sign(
            json!({"groupId":self.genesis["groupId"],"authorDeviceId":device["id"],"authorPublicKey":hex::encode(key.verifying_key().to_bytes()),"clock":clock,"parents":parents,"nonce":random(16),"type":typ,"payload":payload}),
            key,
        );
        e["eventId"] = hash(&e).into();
        self.merge(vec![e.clone()])?;
        Ok(e)
    }
    pub fn proof(&self, op: &str, payload: Value, device: &Value, key: &SigningKey) -> Value {
        sign(
            json!({"protocol":PROTOCOL,"groupId":self.genesis["groupId"],"senderDeviceId":device["id"],"senderPublicKey":hex::encode(key.verifying_key().to_bytes()),"operation":op,"payload":payload,"timestamp":chrono::Utc::now().timestamp_millis(),"nonce":random(24)}),
            key,
        )
    }
    pub fn verify_proof(&mut self, p: &Value, op: &str, unknown: bool) -> Result<Value> {
        let now = chrono::Utc::now().timestamp_millis();
        let ts = p["timestamp"].as_i64().unwrap_or(0);
        ensure!(
            s(p, "protocol") == PROTOCOL
                && p["groupId"] == self.genesis["groupId"]
                && s(p, "operation") == op
                && (now - ts).abs() <= 120000
                && s(p, "nonce").len() == 48
                && hex::decode(s(p, "nonce")).is_ok(),
            "Invalid proof"
        );
        verify(p, s(p, "senderPublicKey"))?;
        ensure!(
            unknown || self.member(s(p, "senderDeviceId"), s(p, "senderPublicKey")),
            "Inactive peer"
        );
        self.replays.retain(|_, until| *until >= now);
        let nonce = format!("{}:{}", s(p, "senderPublicKey"), s(p, "nonce"));
        ensure!(
            !self.replays.contains_key(&nonce) && self.replays.len() < 10000,
            "Replayed proof"
        );
        self.replays.insert(nonce, now + 120000);
        Ok(p["payload"].clone())
    }
    pub fn member(&self, id: &str, key: &str) -> bool {
        self.state["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| s(m, "id") == id && s(m, "publicKey") == key)
    }
    pub fn snapshot(&self) -> Value {
        let mut snapshot = json!({"genesis":self.genesis,"events":self.ordered(None)});
        if !self.revocations.is_empty() {
            snapshot["revocations"] = json!(self.revocations.values().collect::<Vec<_>>());
        }
        snapshot
    }
}
