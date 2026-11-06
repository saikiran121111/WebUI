//! Log-safety helpers: what is allowed inside a production log line.
//!
//! Tool-call arguments are model-authored content about LIVE pages —
//! search queries, form field values, names, addresses, the text typed
//! into someone else's site. Echoing them into `tracing` writes private
//! page work into permanent log files (2026-11-06 audit finding 3).
//! [`arg_shape`] keeps the whole diagnostic value of the old field —
//! which parameters the model used, and how large the call was — while
//! dropping every value.

use serde_json::Value;

/// Log-safe shape of one tool call's argument JSON: parameter NAMES and the
/// byte size, never the values.
///
/// Unparseable input reports only its size, so a malformed blob cannot
/// smuggle arbitrary text into the log either (the arguments are model
/// output, and model output is never trusted content).
pub(crate) fn arg_shape(arguments: &str) -> String {
    let mut keys: Vec<String> = match serde_json::from_str::<Value>(arguments) {
        Ok(Value::Object(map)) => map.keys().cloned().collect(),
        _ => {
            return format!(
                "<arguments are not a JSON object: {} bytes>",
                arguments.len()
            )
        }
    };
    // Sorted so the line is deterministic regardless of how the upstream
    // serialized (or the model streamed) the object.
    keys.sort_unstable();
    format!(
        "{} param(s) [{}] {} bytes",
        keys.len(),
        keys.join(","),
        arguments.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_params_and_never_the_values() {
        let args = r#"{"tab_id":"t3","text":"my home address: 12 Elm Street"}"#;
        let shape = arg_shape(args);
        assert!(
            shape.contains("tab_id"),
            "shape keeps the parameter: {shape}"
        );
        assert!(shape.contains("text"), "shape keeps the parameter: {shape}");
        assert!(
            !shape.contains("12 Elm Street") && !shape.contains("home address"),
            "the typed VALUE must never reach the log: {shape}"
        );
        assert!(shape.contains("2 param(s)"), "counts params: {shape}");
        assert!(
            shape.contains(&format!("{} bytes", args.len())),
            "reports the real size: {shape}"
        );
    }

    #[test]
    fn key_order_is_stable_regardless_of_wire_order() {
        assert_eq!(
            arg_shape(r#"{"b":1,"a":2,"c":3}"#),
            arg_shape(r#"{"c":3,"a":2,"b":1}"#),
        );
    }

    #[test]
    fn an_empty_object_still_reports_its_shape() {
        assert_eq!(arg_shape("{}"), "0 param(s) [] 2 bytes");
    }

    #[test]
    fn unparseable_input_leaks_nothing_but_its_size() {
        // A truncated tool-call blob: the old field printed the first 200
        // chars of it verbatim. Now only the size survives.
        let broken = r#"{"query":"the most secret thing"#;
        let shape = arg_shape(broken);
        assert!(!shape.contains("secret"), "no bytes of the blob: {shape}");
        assert!(
            shape.contains(&format!("{} bytes", broken.len())),
            "{shape}"
        );
    }

    #[test]
    fn non_object_json_is_reported_by_size_only() {
        for v in ["null", "[]", "\"just a string\"", "7"] {
            let shape = arg_shape(v);
            assert!(shape.contains("not a JSON object"), "{v} => {shape}");
            assert!(
                shape.contains(&format!("{} bytes", v.len())),
                "{v} => {shape}"
            );
        }
    }
}
