//! ax.rs — the merged cross-frame Accessibility (AX) tree feeding the
//! aria snapshot (`pw.rs::pw_dom_snapshot`).
//!
//! Phase 2 (MCP cutover) retired the `tab_ax_get_state`/`tab_ax_action`
//! pair (`contract.rs::RETIRED_REFERENCE_COMMANDS`), and with it the
//! recovered reference capture engine: the per-tab navigation state
//! machines, the stabilization sequence (navigation → first paint →
//! AX quiet → candidate → freshness gate → commit), the `[id=N]`
//! revision/diff grammar, the credential attribute matcher, and the
//! closed-shadow/probe machinery. The one read the live snapshot
//! actually uses survives here: the merged per-frame
//! `Accessibility.getFullAXTree` sweep, ported from the recovered
//! engine (`reverse-engineering/internal-browser/
//! dom-snapshot-and-cdp.md` §5.1).
//!
//! Frame-descent law (live-probed dialect of the bundled build):
//! `Accessibility.getFullAXTree` answers with ONLY the queried frame's
//! subtree (the flat read leaves the `Iframe` node's `childIds`
//! empty), so every child frame from `Page.getFrameTree` gets its own
//! `{frameId}` read stitched onto the host `<iframe>` AX node through
//! the `DOM.getFrameOwner` backendNodeId join (probe-verified equal
//! both sides). Node ids are frame-local small integers that collide
//! across frames, so each subtree is renumbered into a fresh id space
//! before stitching. A frame whose reads fail degrades the way the
//! recovered code warns (`Iframe … accessibility unavailable`): the
//! snapshot proceeds without that frame's subtree rather than
//! fabricating one.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cdp::CdpConn;
use crate::errors::BrowserError;

// ── Raw CDP AX tree shapes ────────────────────────────────────────────

/// `Accessibility.AXNode`. `nodeId` (an AXNodeId primitive) is read
/// tolerantly: the JSON wire form varies between string and number
/// across Chromium builds.
#[derive(Clone, Debug, Deserialize)]
struct RawNode {
    #[serde(rename = "nodeId", deserialize_with = "de_node_id")]
    node_id: String,
    #[serde(default)]
    ignored: bool,
    role: Option<RawObj>,
    name: Option<RawName>,
    #[serde(default)]
    properties: Vec<RawProp>,
    #[serde(rename = "childIds", default, deserialize_with = "de_opt_ids")]
    child_ids: Option<Vec<String>>,
    #[serde(rename = "backendDOMNodeId")]
    backend_dom_node_id: Option<i64>,
}

/// The compact merged-AX-tree node shape the aria-snapshot renderer
/// walks (`pw.rs`). It exists so the raw wire structs above stay
/// private to ax.rs; `pw_ax_nodes` is the cross-module contract.
#[derive(Clone, Debug)]
pub(crate) struct PwAxNode {
    pub(crate) node_id: String,
    pub(crate) ignored: bool,
    pub(crate) role: String,
    pub(crate) name: Option<String>,
    pub(crate) props: Vec<(String, Value)>,
    pub(crate) child_ids: Vec<String>,
    pub(crate) bnid: Option<i64>,
}

fn node_id_from_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn de_node_id<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Value::deserialize(d)?;
    Ok(node_id_from_value(&v))
}

fn de_opt_ids<'de, D>(d: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Vec<Value>>::deserialize(d)?;
    Ok(v.map(|vs| vs.iter().map(node_id_from_value).collect()))
}

/// `Accessibility.AXValue` (role/value/description form).
#[derive(Clone, Debug, Deserialize)]
struct RawObj {
    value: Option<Value>,
}

/// `name` as an `Accessibility.AXValue`. The merged read still asks
/// for `includeAXNodeSources`, so the wire may carry a `sources`
/// array (it drove the retired engine's name-source hide rules); the
/// snapshot never consumes it, so the field stays unmodeled.
#[derive(Clone, Debug, Deserialize)]
struct RawName {
    value: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
struct RawProp {
    name: String,
    #[serde(default)]
    value: RawPropVal,
}

/// AX property values: the wire carries `value`; the reference's
/// post-processed form also carried a `bool` convenience field — both
/// shapes are accepted.
#[derive(Clone, Debug, Default, Deserialize)]
struct RawPropVal {
    #[serde(default)]
    value: Option<Value>,
    #[serde(rename = "bool", default)]
    b: Option<bool>,
}

impl RawNode {
    fn role_name(&self) -> String {
        self.role
            .as_ref()
            .and_then(|r| r.value.as_ref())
            .and_then(|v| v.as_str())
            .unwrap_or("none")
            .to_string()
    }

    fn name_str(&self) -> Option<String> {
        self.name
            .as_ref()
            .and_then(|n| n.value.as_ref())
            .and_then(Value::as_str)
            .map(|s| s.to_string())
    }
}

/// The merged cross-frame AX tree (see [`full_ax_nodes`]) re-expressed
/// as the compact [`PwAxNode`] shape the aria-snapshot renderer walks.
/// The raw wire decode stays here so `pw.rs` never touches
/// `Accessibility` wire types.
pub(crate) async fn pw_ax_nodes(
    conn: &CdpConn,
    session: &str,
) -> Result<Vec<PwAxNode>, BrowserError> {
    let raw = full_ax_nodes(conn, session).await?;
    let nodes: Vec<RawNode> =
        serde_json::from_value(Value::Array(raw)).map_err(|e| BrowserError::Internal {
            detail: format!("merged AX tree decode failed: {e}"),
        })?;
    Ok(nodes
        .into_iter()
        .map(|n| PwAxNode {
            ignored: n.ignored,
            role: n.role_name(),
            name: n.name_str(),
            props: n
                .properties
                .iter()
                .map(|p| {
                    let v = p
                        .value
                        .value
                        .clone()
                        .or_else(|| p.value.b.map(Value::Bool))
                        .unwrap_or(Value::Null);
                    (p.name.clone(), v)
                })
                .collect(),
            child_ids: n.child_ids.unwrap_or_default(),
            bnid: n.backend_dom_node_id,
            node_id: n.node_id,
        })
        .collect())
}

/// The merged per-frame AX sweep: the recovered frame-target descent
/// adapted to one flat tab session. Per the module doc, every child
/// frame gets its own `getFullAXTree {frameId}` read stitched onto the
/// host `Iframe` AX node through the `DOM.getFrameOwner` backendNodeId
/// join, with each subtree renumbered into a fresh id space before
/// stitching. Failed frame reads drop that subtree honestly.
async fn full_ax_nodes(conn: &CdpConn, session: &str) -> Result<Vec<Value>, BrowserError> {
    let main = conn
        .call(
            "Accessibility.getFullAXTree",
            Some(json!({ "includeAXNodeSources": true })),
            Some(session),
        )
        .await?;
    let mut nodes: Vec<Value> = match main.get("nodes") {
        Some(Value::Array(arr)) => arr.clone(),
        _ => return Ok(Vec::new()),
    };
    if nodes.is_empty() {
        return Ok(nodes);
    }
    let tree = conn
        .call("Page.getFrameTree", None, Some(session))
        .await
        .unwrap_or(Value::Null);
    // Flatten child frames breadth-first: a host `Iframe` node
    // must already be in `nodes` when its frame stitches onto it.
    let mut queue: Vec<String> = Vec::new();
    {
        let mut frontier: Vec<&Value> = tree
            .pointer("/frameTree/childFrames")
            .and_then(Value::as_array)
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        while !frontier.is_empty() {
            let mut next: Vec<&Value> = Vec::new();
            for entry in frontier {
                if let Some(id) = entry
                    .get("frame")
                    .and_then(|f| f.get("id"))
                    .and_then(Value::as_str)
                {
                    queue.push(id.to_string());
                }
                if let Some(kids) = entry.get("childFrames").and_then(Value::as_array) {
                    next.extend(kids.iter());
                }
            }
            frontier = next;
        }
    }
    let mut cursor = 0usize;
    // Fresh id space for frame subtrees (CDP axNodeIds are small
    // frame-local integers; negatives are InlineTextBox pseudo-ids).
    let mut next_id: i64 = 1_000_000_000;
    while cursor < queue.len() {
        let fid = queue[cursor].clone();
        cursor += 1;
        let owner = match conn
            .call(
                "DOM.getFrameOwner",
                Some(json!({ "frameId": fid.as_str() })),
                Some(session),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sub = match conn
            .call(
                "Accessibility.getFullAXTree",
                Some(json!({ "frameId": fid.as_str(), "includeAXNodeSources": true })),
                Some(session),
            )
            .await
        {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut sub_nodes: Vec<Value> = match sub.get("nodes").and_then(Value::as_array) {
            Some(arr) if !arr.is_empty() => arr.clone(),
            _ => continue,
        };
        // Renumber the subtree into the fresh id space.
        let mut map: HashMap<String, String> = HashMap::with_capacity(sub_nodes.len());
        for n in sub_nodes.iter() {
            let old = n.get("nodeId").map(node_id_from_value).unwrap_or_default();
            let new = next_id.to_string();
            next_id += 1;
            if !old.is_empty() {
                map.insert(old, new);
            }
        }
        let mut sub_root: Option<String> = None;
        for n in sub_nodes.iter_mut() {
            let Some(obj) = n.as_object_mut() else {
                continue;
            };
            let old = obj
                .get("nodeId")
                .map(node_id_from_value)
                .unwrap_or_default();
            let Some(new) = map.get(&old).cloned() else {
                continue;
            };
            if sub_root.is_none()
                && obj
                    .get("role")
                    .and_then(|r| r.get("value"))
                    .and_then(Value::as_str)
                    == Some("RootWebArea")
                && obj.get("ignored").and_then(Value::as_bool) != Some(true)
            {
                sub_root = Some(new.clone());
            }
            obj.insert("nodeId".to_string(), Value::String(new));
            if let Some(ch) = obj.get("childIds").cloned() {
                // Unknown child ids drop silently (same law as the
                // tree walk); never leave a stale frame-local id
                // that could alias a main-tree node.
                let rewritten: Vec<Value> = ch
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|c| {
                                map.get(&node_id_from_value(c))
                                    .map(|n| Value::String(n.clone()))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                obj.insert("childIds".to_string(), Value::Array(rewritten));
            }
        }
        // Stitch onto the host <iframe> AX node. The join search
        // covers only the nodes present BEFORE this frame was
        // merged: backendNodeId uniqueness across frame snapshots
        // is not guaranteed, so never join against a just-merged
        // subtree.
        let host_idx = owner
            .get("backendNodeId")
            .and_then(Value::as_i64)
            .and_then(|b| {
                nodes
                    .iter()
                    .position(|n| n.get("backendDOMNodeId").and_then(Value::as_i64) == Some(b))
            });
        if let (Some(h), Some(root_id)) = (host_idx, sub_root) {
            if let Some(o) = nodes[h].as_object_mut() {
                match o.get_mut("childIds") {
                    Some(Value::Array(arr)) => arr.push(Value::String(root_id)),
                    _ => {
                        o.insert("childIds".to_string(), json!([root_id]));
                    }
                }
            }
        }
        nodes.extend(sub_nodes);
    }
    Ok(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nodes(v: Value) -> Vec<RawNode> {
        serde_json::from_value(v).expect("fixture AX nodes parse")
    }

    #[test]
    fn merged_ax_decode_feeds_the_aria_shape() {
        // pinned wire dialect: nodeIds/childIds string OR number,
        // name as AXValue, property bool convenience shape
        let raws = nodes(json!([
            {"nodeId": "1", "role": {"value": "RootWebArea"},
             "name": {"value": "Page title"}, "childIds": [2, 3],
             "backendDOMNodeId": 12},
            {"nodeId": 2, "ignored": true, "role": {"value": "generic"},
             "properties": [{"name": "focusable", "value": {"bool": true}}]}
        ]));
        assert_eq!(raws[0].role_name(), "RootWebArea");
        assert_eq!(raws[0].name_str().as_deref(), Some("Page title"));
        assert_eq!(
            raws[0].child_ids.as_deref().unwrap(),
            ["2".to_string(), "3".to_string()]
        );
        assert_eq!(raws[0].backend_dom_node_id, Some(12));
        assert!(raws[1].ignored);
        let p = &raws[1].properties[0];
        let v = p
            .value
            .value
            .clone()
            .or_else(|| p.value.b.map(Value::Bool))
            .unwrap();
        assert_eq!(v, Value::Bool(true));
    }
}
