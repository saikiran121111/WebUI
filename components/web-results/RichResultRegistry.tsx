"use client";
/**
 * RichResultRegistry.tsx — the kind → component map for ALL 29 protocol
 * kinds (§2). §80 universal-platform law: a new provider needs only a
 * payload adapter upstream; the renderer side changes ONLY by adding a
 * kind component here (or nothing at all — unknown kinds fall through to
 * the generic card and NEVER crash the response, §2/§59).
 *
 * Heavy third-party code (YouTube embed, OSM map) rides on iframes that
 * mount lazily inside their components (§62–§65), so no additional JS
 * chunk is required — nothing in this registry pulls Three.js, Mermaid,
 * or any artifact library (§5.1 stays intact, §66 untouched).
 */
import type { ComponentType } from "react";
import type { RichResult, RichResultKind } from "../../lib/web-search/rich-results";
import {
  AudioResult, GenericResult, ImageGallery, SourcesSurface, VideoResult, YouTubeResult,
} from "./SurfacesMedia";
import { LocalBusinessSurface, MapResult } from "./SurfacesGeo";
import {
  EntityCard, FinanceQuote, MetricSurface, NewsResult, SportsResult, TrackerResult, WeatherResult,
} from "./SurfacesInfo";
import {
  EventSurface, JobSurface, ProductComparison, ProductSurface, ReservationSlots, RestaurantSurface,
} from "./SurfacesCommerce";
import {
  AppResult, ChartResult, FlashcardDeck, QuizResult, SimulationResult, TableResult, TimelineResult,
} from "./SurfacesData";

type SurfaceComponent = ComponentType<{ surface: RichResult }>;

const REGISTRY: Partial<Record<RichResultKind, SurfaceComponent>> = {
  generic: GenericResult,
  sources: SourcesSurface,
  image_gallery: ImageGallery,
  video: VideoResult,
  audio: AudioResult,
  map: MapResult,
  local_business: LocalBusinessSurface,
  weather: WeatherResult,
  finance: FinanceQuote,
  sports: SportsResult,
  news: NewsResult,
  product: ProductSurface,
  product_carousel: ProductSurface,
  product_comparison: ProductComparison,
  restaurant: RestaurantSurface,
  reservation: ReservationSlots,
  job: JobSurface,
  event: EventSurface,
  tracker: TrackerResult,
  entity: EntityCard,
  table: TableResult,
  chart: ChartResult,
  metrics: MetricSurface,
  timeline: TimelineResult,
  flashcards: FlashcardDeck,
  quiz: QuizResult,
  simulation: SimulationResult,
  app: AppResult,
  // §2: "file" has no dedicated local viewer yet — the generic card shows
  // its structured entries + provenance; unknown kinds land here too.
  file: GenericResult,
};

/** Resolve a kind to its component; unknown → GenericResult (§2). */
export function surfaceComponentFor(kind: string): SurfaceComponent {
  return REGISTRY[kind as RichResultKind] ?? GenericResult;
}

export function renderSurface(surface: RichResult): JSX.Element {
  const C = surfaceComponentFor(surface.kind);
  return <C surface={surface} />;
}
