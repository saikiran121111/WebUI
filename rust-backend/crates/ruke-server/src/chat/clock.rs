//! P1 clock grounding ⇔ `lib/chat/clock-context.ts`.
//!
//! The `<runtime_clock>` system block [`pipeline`](super::pipeline) injects
//! into every normal model turn — the main model has never carried a live
//! clock, so "what time is it?" used to become a refusal or a web-search
//! detour (defects RC1/RC8; parity doc P1). The block wording is
//! byte-identical to the TS `buildClockBlock` for the same fields: the TS
//! oracle owns the spec, and the unit tests here and in
//! `__tests__/chat/clock-context.test.ts` pin the SAME instants and the
//! SAME exact strings.
//!
//! APPROVED DEVIATION (mirror parity law): with no valid IANA name
//! (missing/garbage `timezone`), TS falls back to the SERVER's own zone
//! labeled by its IANA name (Intl provides it); `chrono::Local` exposes
//! only a fixed offset, so the Rust fallback labels the zone `UTC±HH:MM`.
//! The WebUI client always sends the browser zone (hooks/useChat.ts), so
//! this path is reached only by direct API callers.

use chrono::Offset as _;
use chrono::{DateTime, Local, Utc};
use chrono_tz::Tz;

/// ⇔ `buildClockContext`: resolve the session zone, format the live values
/// in it, and emit the block. `now_utc` is caller-supplied so the unit
/// tests never read the wall clock.
pub fn build_clock_block(browser_timezone: Option<&str>, now_utc: DateTime<Utc>) -> String {
    let name = browser_timezone.map(str::trim).filter(|s| !s.is_empty());
    if let Some(n) = name {
        if let Ok(tz) = n.parse::<Tz>() {
            let local = now_utc.with_timezone(&tz);
            return build_clock_text(
                &local.format("%A %Y-%m-%d %H:%M:%S").to_string(),
                &signed_offset(local.offset().fix().local_minus_utc()),
                n,
            );
        }
    }
    // Fallback ⇔ TS server-zone default (see the DEVIATION note above).
    let local = now_utc.with_timezone(&Local);
    let off = signed_offset(local.offset().local_minus_utc());
    build_clock_text(
        &local.format("%A %Y-%m-%d %H:%M:%S").to_string(),
        &off,
        &format!("UTC{off}"),
    )
}

/// ⇔ TS `buildClockBlock`. Static wording: change it HERE and there
/// together, or the pinned parity tests on both sides fire.
pub fn build_clock_text(date_time: &str, offset: &str, timezone_label: &str) -> String {
    format!(
        "<runtime_clock>\n\
         Current date/time: {date_time} (UTC{offset}) — session timezone: {timezone_label} (IANA).\n\
         This clock is authoritative and live: the server injects it fresh into every turn, immediately before the current user message.\n\
         Answer any current-time, date, or day-of-week question directly from this line, in the session timezone shown. NEVER claim that you lack a clock, cannot see the current time, or that your knowledge is frozen at a training cutoff.\n\
         Use this clock — never a web search — whenever you reason about \"today\", \"now\", \"this year\", or staleness.\n\
         </runtime_clock>"
    )
}

/// Signed `±HH:MM` zone offset ⇔ TS `utcOffset` (DST-aware: the caller's
/// `DateTime` already carries the historical offset for its instant).
fn signed_offset(secs: i32) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let abs = secs.abs();
    format!("{sign}{:02}:{:02}", abs / 3600, (abs % 3600) / 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// The exact strings pinned by the TS mirror
    /// (`__tests__/chat/clock-context.test.ts`): same instant, same zone,
    /// byte-identical block.
    #[test]
    fn fixed_instant_emits_the_pinned_block() {
        let utc = Utc.with_ymd_and_hms(2026, 11, 1, 13, 0, 0).unwrap();
        let block = build_clock_block(Some("Asia/Kolkata"), utc);
        assert_eq!(
            block,
            "<runtime_clock>\n\
             Current date/time: Sunday 2026-11-01 18:30:00 (UTC+05:30) — session timezone: Asia/Kolkata (IANA).\n\
             This clock is authoritative and live: the server injects it fresh into every turn, immediately before the current user message.\n\
             Answer any current-time, date, or day-of-week question directly from this line, in the session timezone shown. NEVER claim that you lack a clock, cannot see the current time, or that your knowledge is frozen at a training cutoff.\n\
             Use this clock — never a web search — whenever you reason about \"today\", \"now\", \"this year\", or staleness.\n\
             </runtime_clock>"
        );
    }

    /// Same two instants as the TS mirror's DST matrix.
    #[test]
    fn dst_aware_offset_across_the_year() {
        let jul = Utc.with_ymd_and_hms(2026, 7, 4, 16, 0, 0).unwrap();
        let jan = Utc.with_ymd_and_hms(2026, 1, 15, 16, 0, 0).unwrap();
        assert!(build_clock_block(Some("America/New_York"), jul)
            .contains("2026-07-04 12:00:00 (UTC-04:00)"));
        assert!(build_clock_block(Some("America/New_York"), jan)
            .contains("2026-01-15 11:00:00 (UTC-05:00)"));
    }

    #[test]
    fn garbage_zone_falls_back_without_failing() {
        let utc = Utc.with_ymd_and_hms(2026, 7, 4, 16, 0, 0).unwrap();
        for bad in [None, Some(""), Some("   "), Some("Not/AZone!!")] {
            let block = build_clock_block(bad, utc);
            assert!(block.starts_with("<runtime_clock>\nCurrent date/time: "));
            assert!(block.ends_with("\n</runtime_clock>"));
        }
    }
}
