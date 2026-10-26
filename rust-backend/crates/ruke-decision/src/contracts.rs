//! `MODE_CONTRACTS` — the per-mode output-contract blocks
//! (`lib/decision/contracts.ts`). The exact bytes live in
//! `contracts_generated.rs`, emitted by importing the live TS module in
//! `rust-backend/scripts/gen-mode-contracts.mjs`; NEVER hand-edit or
//! hand-copy them. `standard_chat` maps to `null` in the TS table → `None`.

use ruke_contracts::decision::RendererMode;

use crate::contracts_generated::{
    CONTRACT_3D_ASSET, CONTRACT_CAD_BLUEPRINT, CONTRACT_CHART, CONTRACT_DOCS, CONTRACT_EXCEL,
    CONTRACT_HTML_RENDER, CONTRACT_PDF, CONTRACT_PPT,
};

/// `MODE_CONTRACTS[mode]` lookup.
pub fn mode_contract(mode: RendererMode) -> Option<&'static str> {
    match mode {
        RendererMode::Excel => Some(CONTRACT_EXCEL),
        RendererMode::Docs => Some(CONTRACT_DOCS),
        RendererMode::Pdf => Some(CONTRACT_PDF),
        RendererMode::Ppt => Some(CONTRACT_PPT),
        RendererMode::Asset3D => Some(CONTRACT_3D_ASSET),
        RendererMode::CadBlueprint => Some(CONTRACT_CAD_BLUEPRINT),
        RendererMode::Chart => Some(CONTRACT_CHART),
        RendererMode::HtmlRender => Some(CONTRACT_HTML_RENDER),
        RendererMode::StandardChat => None,
    }
}
