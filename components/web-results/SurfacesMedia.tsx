"use client";
/**
 * SurfacesMedia.tsx — image gallery, video, YouTube (§7), audio (§10) and
 * the generic card (§2 unknown-kind fallback). §3 law: nothing here
 * invents a thumbnail, a duration, a channel name, or a caption — every
 * value is read from the validated payload, and a missing value simply
 * stays absent.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultFrame } from "./RichResultFrame";
import { ResultCard, ResultEmpty, ResultGallery, galleryImages } from "./ResultPrimitives";
import { ResultCarousel } from "./ResultChrome";
import { itemsOf, safeUrl, str, num, duration as fmtDuration, hostOf, itemProvenance } from "./resultHelpers";
import { useRichResultCtx } from "./richResultContext";

/* ── ImageGallery (§6): provenance always, thumbnails over giant files,
 *  lazy loading, lightbox on user click ────────────────────────────────── */
export const ImageGallery = memo(function ImageGallery({ surface }: { surface: RichResult }) {
  const images = galleryImages(surface.payload as Record<string, unknown>);
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      <ResultGallery images={images} />
    </RichResultFrame>
  );
});

/* ── YouTube (§7): the repo's privacy stance — the play button mounts a
 *  youtube-nocookie embed; before play NOTHING third-party loads. No
 *  autoplay ever. Fallback = thumbnail + "Open on YouTube". ─────────────── */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_THUMB_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/hqdefault\.jpg$/;

export const YouTubeResult = memo(function YouTubeResult({ surface }: { surface: RichResult }) {
  const ctx = useRichResultCtx();
  const p = surface.payload as Record<string, unknown>;
  const videoId = str(p.videoId, 16);
  const watchUrl = safeUrl(p.url);
  const thumb = safeUrl(p.thumbnail);
  const playing = videoId && YT_ID_RE.test(videoId);
  const [play, setPlay] = useState(false);
  const [start, setStart] = useState(0);
  const surfaceId = surface.id;
  const chapters = itemsOf(p, "chapters").slice(0, 24);

  // §40 seek_media: seeking a not-yet-playing embed just moves the start
  // parameter — honest, and it never loads the frame without a click.
  useEffect(() => {
    const off = ctx?.registerSeeker?.(surfaceId, (s) => { setStart(Math.max(0, Math.floor(s))); setPlay(true); });
    return off;
  }, [ctx, surfaceId]);

  if (!playing) {
    // Malformed payload (§75): degrade to the source card, never a player.
    return (
      <RichResultFrame surface={surface}>
        {watchUrl
          ? <ResultCard title={str(p.title, 200) ?? "Video"} lines={[hostOf(watchUrl)]} href={watchUrl} />
          : <ResultEmpty text="No playable video." />}
      </RichResultFrame>
    );
  }
  const thumbUrl = thumb && YT_THUMB_RE.test(thumb) ? thumb : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return (
    <RichResultFrame surface={surface} supportsFullscreen>
      {play ? (
        <iframe
          className="wr-embed-frame"
          title={str(p.title, 200) ?? "YouTube video"}
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&start=${start}&rel=0`}
          allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      ) : (
        <div className="wr-thumb">
          <button type="button" className="wr-thumb-btn" aria-label={`Play: ${str(p.title, 200) ?? "video"}`}
            onClick={() => setPlay(true)}>
            <img src={thumbUrl} alt={str(p.title, 200) ?? "Video thumbnail"} loading="lazy" />
            <span className="wr-play" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </span>
            {num(p.duration) !== undefined && <span className="wr-duration">{fmtDuration(p.duration)}</span>}
          </button>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {str(p.title, 200) && <div className="wr-card-title">{str(p.title, 200)}</div>}
        <div className="wr-credit">
          {str(p.channel, 120) ?? "YouTube"}
          {watchUrl && <> · <a href={watchUrl} target="_blank" rel="noopener noreferrer">Open on YouTube</a></>}
        </div>
      </div>
      {chapters.length > 0 && (
        <div className="wr-list" style={{ marginTop: 8 }} role="list" aria-label="Video chapters">
          {chapters.map((c, i) => {
            const t = num(c.t);
            return (
              <button key={i} type="button" className="wr-pin-row" role="listitem"
                onClick={() => { if (t !== undefined) setStart(Math.floor(t)); setPlay(true); }}>
                <span>{str(c.label, 160) ?? `Chapter ${i + 1}`}</span>
                {t !== undefined && <span className="wr-card-note">{fmtDuration(t)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </RichResultFrame>
  );
});

/* ── §9 generic video: native <video> for known-safe URLs only, controls,
 *  no autoplay; a seek action drives the element ref. ──────────────────── */
export const VideoResult = memo(function VideoResult({ surface }: { surface: RichResult }) {
  const ctx = useRichResultCtx();
  const p = surface.payload as Record<string, unknown>;
  const src = safeUrl(p.url);
  // §9: native <video> is for known-safe DIRECT media URLs only. A YouTube
  // watch URL is an HTML page, never a media file — evidence carrying a
  // videoId or a YouTube host dispatches to YouTubeResult (§7), which is
  // also the only path allowed to mount the nocookie embed.
  const host = src ? hostOf(src) : "";
  if (str(p.videoId, 16) || /(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com)$/i.test(host)) {
    return <YouTubeResult surface={surface} />;
  }
  const ref = useRef<HTMLVideoElement | null>(null);
  const surfaceId = surface.id;
  useEffect(() => {
    const off = ctx?.registerSeeker?.(surfaceId, (s) => {
      const el = ref.current;
      if (el && Number.isFinite(s)) { el.currentTime = s; el.play().catch(() => { /* user-gesture law: play may reject */ }); }
    });
    return off;
  }, [ctx, surfaceId]);
  return (
    <RichResultFrame surface={surface}>
      {src
        ? <video ref={ref} className="wr-video-native" controls preload="metadata" src={src}
            poster={safeUrl(p.thumbnail)} aria-label={str(p.title, 200) ?? "Video"} />
        : <ResultEmpty text="No playable video." />}
      {str(p.title, 200) && <div className="wr-card-title" style={{ marginTop: 6 }}>{str(p.title, 200)}</div>}
      {src && <div className="wr-credit">{hostOf(src)}</div>}
    </RichResultFrame>
  );
});

/* ── §10 audio: no autoplay, native controls, provenance line. ────────── */
export const AudioResult = memo(function AudioResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const src = safeUrl(p.url);
  return (
    <RichResultFrame surface={surface}>
      {src
        ? <audio className="wr-audio" controls preload="metadata" src={src} aria-label={str(p.title, 200) ?? "Audio"} />
        : <ResultEmpty text="No playable audio." />}
      <div className="wr-credit" style={{ marginTop: 6 }}>
        {str(p.title, 200) ?? "Audio"}{src ? ` · ${hostOf(src)}` : ""}
        {num(p.duration) !== undefined ? ` · ${fmtDuration(p.duration)}` : ""}
      </div>
    </RichResultFrame>
  );
});

/* ── generic (§2): plain cards over the structured items; the universal
 *  fallback for ANY unknown kind — it never crashes. ──────────────────── */
export const GenericResult = memo(function GenericResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).length ? itemsOf(p) : itemsOf(p, "items");
  return (
    <RichResultFrame surface={surface}>
      {str(p.text, 2000) && <p className="wr-card-line" style={{ margin: 0 }}>{str(p.text, 2000)}</p>}
      {items.length > 0 && (
        <div className="wr-list">
          {items.slice(0, 12).map((it, i) => (
            <ResultCard key={i}
              title={str(it.title, 200) ?? str(it.name, 200)}
              lines={(Array.isArray(it.lines) ? it.lines : []).map((l) => str(l, 200) ?? "").filter(Boolean).slice(0, 4)}
              note={itemProvenance(it)}
              href={safeUrl(it.url)} />
          ))}
        </div>
      )}
      {!items.length && !str(p.text, 2000) && <ResultEmpty text="No structured details — see sources." />}
    </RichResultFrame>
  );
});

/* ── sources (§2): a structured list of sources as its own surface. ────── */
export const SourcesSurface = memo(function SourcesSurface({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const items = itemsOf(p).slice(0, 20);
  return (
    <RichResultFrame surface={surface}>
      {items.length
        ? <ResultCarousel label="Sources">{items.map((it, i) => (
            <ResultCard key={i} title={str(it.title, 200) ?? hostOf(safeUrl(it.url) ?? "")}
              lines={[str(it.domain, 100) ?? (safeUrl(it.url) ? hostOf(safeUrl(it.url)!) : ""), str(it.publishedAt, 40)].filter((x): x is string => !!x)}
              href={safeUrl(it.url)} />
          ))}</ResultCarousel>
        : <ResultEmpty text="No sources listed." />}
    </RichResultFrame>
  );
});
