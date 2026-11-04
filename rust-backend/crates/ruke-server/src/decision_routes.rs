//! `POST /api/ruke/decision` — the route wrapper for the Part-7
//! in-process decision engine (`ruke_decision::engine::decision_route`
//! already byte-mirrors `app/api/decision/route.ts`, including the 400
//! bodies). Until Part 8 the plain `/api/decision` path stays Next-owned;
//! this mount lives under the Rust-only `/api/ruke` namespace exactly like
//! the other Part-7 services.
//!
//! DOCUMENTED DEVIATION (same one as `/api/chat`): Next imposes no body
//! cap; `read_capped` guards the process at MAX_CHAT_BODY and maps an
//! over-limit/exhausted read to the Next-500 equivalent. Decision
//! payloads are a single message string — orders of magnitude below the
//! cap in any real client.

use axum::extract::{Request, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::chat::handler::{read_capped, MAX_CHAT_BODY};
use crate::AppState;

pub async fn decision_post(State(_state): State<AppState>, req: Request) -> Response {
    // The decision engine is stateless (in-process deterministic router);
    // `State` rides only for router-shape parity with the other mounts.
    let raw = match read_capped(req.into_body(), MAX_CHAT_BODY).await {
        Some(b) => b,
        None => {
            tracing::warn!("decision request body read failed or exceeded the size cap");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    // TS `await req.text()` then JSON.parse inside the engine; lossy
    // decode only affects bytes a browser fetch could not have produced.
    let resp = ruke_decision::engine::decision_route(&String::from_utf8_lossy(&raw));
    let status = StatusCode::from_u16(resp.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    // NextResponse.json ⇒ exactly `application/json` (no charset — same
    // as axum's own JSON responses).
    (
        status,
        [(
            CONTENT_TYPE,
            axum::http::HeaderValue::from_static("application/json"),
        )],
        resp.body,
    )
        .into_response()
}
